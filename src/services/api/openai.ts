import type { BetaJSONOutputFormat } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import type { Tool, Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import { toolToAPISchema } from '../../utils/api.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  createAssistantAPIErrorMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getOpenAIAPIMode, getOpenAIClient } from './openaiClient.js'
import type { Options } from './claude.js'

type OpenAIInputItem = Record<string, unknown>
type OpenAIOutputItem = Record<string, unknown>
type OpenAIChatMessage = Record<string, unknown>

function shouldFallbackResponsesToChatCompletions(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes("invalid value: 'input_text'") ||
    (message.includes('input_text') &&
      message.includes('supported values are') &&
      message.includes('output_text'))
  )
}

function toOpenAITextInput(text: string): OpenAIInputItem {
  return {
    type: 'input_text',
    text,
  }
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') {
          return part
        }
        if (part && typeof part === 'object' && 'type' in part) {
          if (part.type === 'text' && 'text' in part) {
            return String(part.text)
          }
          if ('content' in part && typeof part.content === 'string') {
            return String(part.content)
          }
        }
        return jsonStringify(part)
      })
      .join('\n')
  }
  return jsonStringify(content)
}

function flushBufferedMessage(
  items: OpenAIInputItem[],
  role: 'assistant' | 'user',
  bufferedText: string[],
): void {
  if (bufferedText.length === 0) {
    return
  }
  items.push({
    type: 'message',
    role,
    content: bufferedText.map(text => toOpenAITextInput(text)),
  })
  bufferedText.length = 0
}

function cloneOpenAIOutputItems(items: unknown): OpenAIOutputItem[] {
  if (!Array.isArray(items)) {
    return []
  }
  return JSON.parse(JSON.stringify(items)) as OpenAIOutputItem[]
}

function messageToOpenAIInputItems(message: Message): OpenAIInputItem[] {
  const items: OpenAIInputItem[] = []
  const content = Array.isArray(message.message?.content)
    ? message.message.content
    : typeof message.message?.content === 'string'
      ? [{ type: 'text', text: message.message.content }]
      : []

  if (message.type === 'assistant') {
    const rawOutput = cloneOpenAIOutputItems(
      (message as AssistantMessage & {
        openaiResponseOutput?: unknown
      }).openaiResponseOutput,
    )
    if (rawOutput.length > 0) {
      return rawOutput
    }
  }

  const bufferedText: string[] = []
  const role = message.type === 'assistant' ? 'assistant' : 'user'

  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      continue
    }

    if (block.type === 'tool_result' && role === 'user') {
      flushBufferedMessage(items, 'user', bufferedText)
      items.push({
        type: 'function_call_output',
        call_id:
          'tool_use_id' in block && typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : randomUUID(),
        output: normalizeToolResultContent(
          'content' in block ? block.content : undefined,
        ),
      })
      continue
    }

    if (block.type === 'tool_use' && role === 'assistant') {
      flushBufferedMessage(items, 'assistant', bufferedText)
      items.push({
        type: 'function_call',
        call_id:
          'id' in block && typeof block.id === 'string' ? block.id : randomUUID(),
        name: 'name' in block ? String(block.name) : 'unknown_tool',
        arguments: jsonStringify('input' in block ? block.input : {}),
      })
      continue
    }

    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      bufferedText.push(block.text)
      continue
    }

    bufferedText.push(normalizeToolResultContent(block))
  }

  flushBufferedMessage(items, role, bufferedText)
  return items
}

function buildOpenAIInput(messages: Message[], tools: Tools): OpenAIInputItem[] {
  const normalizedMessages = normalizeMessagesForAPI(messages, tools)
  const items: OpenAIInputItem[] = []
  for (const message of normalizedMessages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }
    items.push(...messageToOpenAIInputItems(message))
  }
  return items
}

async function buildOpenAITools(
  tools: Tools,
  options: Options,
): Promise<Array<Record<string, unknown>>> {
  const openAITools: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: options.getToolPermissionContext,
      tools,
      agents: options.agents,
      allowedAgentTypes: options.allowedAgentTypes,
      model: options.model,
    })) as unknown as {
      name: string
      description: string
      input_schema: Record<string, unknown>
      strict?: boolean
    }
    openAITools.push({
      type: 'function',
      name: schema.name,
      description: schema.description,
      parameters: schema.input_schema,
      ...(schema.strict ? { strict: true } : {}),
    })
  }
  return openAITools
}

async function buildOpenAIChatTools(
  tools: Tools,
  options: Options,
): Promise<Array<Record<string, unknown>>> {
  const responseTools = await buildOpenAITools(tools, options)
  return responseTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict ? { strict: true } : {}),
    },
  }))
}

function mapToolChoice(toolChoice: Options['toolChoice']): unknown {
  if (!toolChoice) {
    return undefined
  }
  if (toolChoice.type === 'auto') {
    return 'auto'
  }
  if (toolChoice.type === 'tool') {
    return {
      type: 'function',
      name: toolChoice.name,
    }
  }
  return undefined
}

function mapStructuredOutput(
  outputFormat: BetaJSONOutputFormat | undefined,
): Record<string, unknown> | undefined {
  if (!outputFormat || outputFormat.type !== 'json_schema') {
    return undefined
  }
  return {
    format: {
      type: 'json_schema',
      name: 'structured_output',
      schema: outputFormat.schema,
      strict: true,
    },
  }
}

function mapChatStructuredOutput(
  outputFormat: BetaJSONOutputFormat | undefined,
): Record<string, unknown> | undefined {
  if (!outputFormat || outputFormat.type !== 'json_schema') {
    return undefined
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'structured_output',
      schema: outputFormat.schema,
      strict: true,
    },
  }
}

function mapReasoningConfig(
  thinkingConfig: ThinkingConfig,
  options: Options,
): Record<string, unknown> | undefined {
  if (typeof options.effortValue === 'string') {
    const effort =
      options.effortValue === 'max' ? 'high' : options.effortValue
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      return { effort }
    }
  }
  if (thinkingConfig.type !== 'disabled') {
    return { effort: 'medium' }
  }
  return undefined
}

function createOpenAIUsage(usage: unknown): Record<string, unknown> {
  const u = (usage ?? {}) as Record<string, unknown>
  return {
    input_tokens:
      typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    output_tokens:
      typeof u.output_tokens === 'number' ? u.output_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  }
}

function messageTextToString(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        return ''
      }
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messageToOpenAIChatMessages(message: Message): OpenAIChatMessage[] {
  const content = Array.isArray(message.message?.content)
    ? message.message.content
    : typeof message.message?.content === 'string'
      ? [{ type: 'text', text: message.message.content }]
      : []
  const chatMessages: OpenAIChatMessage[] = []
  const bufferedText: string[] = []

  if (message.type === 'assistant') {
    const toolCalls: Array<Record<string, unknown>> = []
    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        continue
      }
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        bufferedText.push(block.text)
        continue
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id:
            'id' in block && typeof block.id === 'string' ? block.id : randomUUID(),
          type: 'function',
          function: {
            name: 'name' in block ? String(block.name) : 'unknown_tool',
            arguments: jsonStringify('input' in block ? block.input : {}),
          },
        })
      }
    }
    if (bufferedText.length > 0 || toolCalls.length > 0) {
      chatMessages.push({
        role: 'assistant',
        content: bufferedText.length > 0 ? bufferedText.join('\n') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
    return chatMessages
  }

  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      continue
    }
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      bufferedText.push(block.text)
      continue
    }
    if (block.type === 'tool_result') {
      if (bufferedText.length > 0) {
        chatMessages.push({
          role: 'user',
          content: bufferedText.join('\n'),
        })
        bufferedText.length = 0
      }
      chatMessages.push({
        role: 'tool',
        tool_call_id:
          'tool_use_id' in block && typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : randomUUID(),
        content: normalizeToolResultContent(
          'content' in block ? block.content : undefined,
        ),
      })
    }
  }

  if (bufferedText.length > 0) {
    chatMessages.push({
      role: 'user',
      content: bufferedText.join('\n'),
    })
  }
  return chatMessages
}

function buildOpenAIChatMessages(
  messages: Message[],
  tools: Tools,
  systemPrompt: SystemPrompt,
): OpenAIChatMessage[] {
  const normalizedMessages = normalizeMessagesForAPI(messages, tools)
  const chatMessages: OpenAIChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt.join('\n\n'),
    },
  ]
  for (const message of normalizedMessages) {
    if (message.type !== 'assistant' && message.type !== 'user') {
      continue
    }
    chatMessages.push(...messageToOpenAIChatMessages(message))
  }
  return chatMessages
}

function mapChatToolChoice(toolChoice: Options['toolChoice']): unknown {
  if (!toolChoice) {
    return undefined
  }
  if (toolChoice.type === 'auto') {
    return 'auto'
  }
  if (toolChoice.type === 'tool') {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    }
  }
  return undefined
}

function createOpenAIUsageFromChat(usage: unknown): Record<string, unknown> {
  const u = (usage ?? {}) as Record<string, unknown>
  return createOpenAIUsage({
    input_tokens:
      typeof u.prompt_tokens === 'number'
        ? u.prompt_tokens
        : typeof u.input_tokens === 'number'
          ? u.input_tokens
          : 0,
    output_tokens:
      typeof u.completion_tokens === 'number'
        ? u.completion_tokens
        : typeof u.output_tokens === 'number'
          ? u.output_tokens
          : 0,
  })
}

function chatCompletionToAssistantMessage(
  response: Record<string, unknown>,
  model: string,
): AssistantMessage {
  const choices = Array.isArray(response.choices)
    ? (response.choices as Array<Record<string, unknown>>)
    : []
  const choice = choices[0] ?? {}
  const message = (choice.message ?? {}) as Record<string, unknown>
  const content: Array<Record<string, unknown>> = []

  const messageContent = message.content
  if (typeof messageContent === 'string' && messageContent.length > 0) {
    content.push({
      type: 'text',
      text: messageContent,
    })
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        content.push({
          type: 'text',
          text: part.text,
        })
      }
    }
  }

  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : []
  for (const toolCall of toolCalls) {
    const fn =
      toolCall.function && typeof toolCall.function === 'object'
        ? (toolCall.function as Record<string, unknown>)
        : {}
    const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : '{}'
    content.push({
      type: 'tool_use',
      id:
        typeof toolCall.id === 'string' ? toolCall.id : `call_${randomUUID()}`,
      name: typeof fn.name === 'string' ? fn.name : 'unknown_tool',
      input: safeParseJSON(rawArgs) ?? { _raw: rawArgs },
    })
  }

  const finishReason =
    typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined

  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: typeof response.id === 'string' ? response.id : undefined,
    message: {
      id:
        typeof response.id === 'string'
          ? response.id
          : `chatcmpl_${randomUUID()}`,
      role: 'assistant',
      type: 'message',
      model,
      content,
      usage: createOpenAIUsageFromChat(response.usage),
      stop_reason:
        finishReason === 'tool_calls'
          ? 'tool_use'
          : finishReason === 'length'
            ? 'max_tokens'
            : 'end_turn',
      stop_sequence: null,
      context_management: null,
    },
  }
}

function outputItemsToAssistantMessage(
  response: Record<string, unknown>,
  model: string,
): AssistantMessage {
  const outputItems = Array.isArray(response.output)
    ? (response.output as OpenAIOutputItem[])
    : []
  const content: Array<Record<string, unknown>> = []

  for (const item of outputItems) {
    if (item.type === 'message' && item.role === 'assistant') {
      const parts = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : []
      for (const part of parts) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          content.push({
            type: 'text',
            text: part.text,
          })
          continue
        }
        if ('text' in part && typeof part.text === 'string') {
          content.push({
            type: 'text',
            text: part.text,
          })
        }
      }
      continue
    }

    if (item.type === 'function_call') {
      const parsedInput =
        typeof item.arguments === 'string'
          ? safeParseJSON(item.arguments) ?? { _raw: item.arguments }
          : (item.arguments ?? {})
      content.push({
        type: 'tool_use',
        id:
          typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : randomUUID(),
        name: typeof item.name === 'string' ? item.name : 'unknown_tool',
        input: parsedInput,
      })
    }
  }

  if (
    content.length === 0 &&
    typeof response.output_text === 'string' &&
    response.output_text.length > 0
  ) {
    content.push({
      type: 'text',
      text: response.output_text,
    })
  }

  const hasToolUse = content.some(block => block.type === 'tool_use')
  const incompleteReason =
    typeof response.incomplete_details === 'object' &&
    response.incomplete_details &&
    'reason' in (response.incomplete_details as Record<string, unknown>)
      ? String(
          (response.incomplete_details as Record<string, unknown>).reason,
        )
      : null

  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: typeof response.id === 'string' ? response.id : undefined,
    openaiResponseOutput: outputItems,
    message: {
      id:
        typeof response.id === 'string'
          ? response.id
          : `resp_${randomUUID()}`,
      role: 'assistant',
      type: 'message',
      model,
      content,
      usage: createOpenAIUsage(response.usage),
      stop_reason: hasToolUse
        ? 'tool_use'
        : incompleteReason === 'max_output_tokens'
          ? 'max_tokens'
          : 'end_turn',
      stop_sequence: null,
      context_management: null,
    },
  }
}

export async function* queryOpenAIModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    const client = getOpenAIClient({
      maxRetries: 2,
      fetchOverride: options.fetchOverride,
    })
    const model = normalizeModelStringForAPI(options.model)
    const chatMessages = buildOpenAIChatMessages(messages, tools, systemPrompt)
    const chatTools = await buildOpenAIChatTools(tools, options)
    const createChatCompletion = async () =>
      ((await client.chat.completions.create(
        {
          model,
          messages: chatMessages as never,
          ...(chatTools.length > 0 ? { tools: chatTools as never } : {}),
          ...(mapChatToolChoice(options.toolChoice)
            ? { tool_choice: mapChatToolChoice(options.toolChoice) as never }
            : {}),
          ...(options.maxOutputTokensOverride
            ? { max_completion_tokens: options.maxOutputTokensOverride }
            : {}),
          ...(options.temperatureOverride !== undefined
            ? { temperature: options.temperatureOverride }
            : {}),
          ...(mapChatStructuredOutput(options.outputFormat)
            ? { response_format: mapChatStructuredOutput(options.outputFormat) as never }
            : {}),
        },
        {
          signal,
        },
      )) as unknown as Record<string, unknown>)
    if (getOpenAIAPIMode() === 'chat_completions') {
      const response = await createChatCompletion()

      yield {
        type: 'stream_event',
        event: {
          type: 'response.completed',
          response_id: response.id,
        },
      }

      yield chatCompletionToAssistantMessage(response, model)
      return
    }
    const input = buildOpenAIInput(messages, tools)
    const openAITools = await buildOpenAITools(tools, options)
    let response: Record<string, unknown>
    try {
      response = (await client.responses.create({
        model,
        instructions: systemPrompt.join('\n\n'),
        input,
        ...(openAITools.length > 0 ? { tools: openAITools } : {}),
        ...(mapToolChoice(options.toolChoice)
          ? { tool_choice: mapToolChoice(options.toolChoice) }
          : {}),
        ...(options.maxOutputTokensOverride
          ? { max_output_tokens: options.maxOutputTokensOverride }
          : {}),
        ...(options.temperatureOverride !== undefined
          ? { temperature: options.temperatureOverride }
          : {}),
        ...(mapStructuredOutput(options.outputFormat)
          ? { text: mapStructuredOutput(options.outputFormat) }
          : {}),
        ...(mapReasoningConfig(thinkingConfig, options)
          ? { reasoning: mapReasoningConfig(thinkingConfig, options) }
          : {}),
        parallel_tool_calls: true,
      }, {
        signal,
      })) as unknown as Record<string, unknown>
    } catch (error) {
      if (!shouldFallbackResponsesToChatCompletions(error)) {
        throw error
      }
      logForDebugging(
        `[OpenAI] Responses API unsupported by current endpoint, retrying with chat.completions: ${errorMessage(error)}`,
        { level: 'warning' },
      )
      const chatResponse = await createChatCompletion()
      yield {
        type: 'stream_event',
        event: {
          type: 'response.completed',
          response_id: chatResponse.id,
        },
      }
      yield chatCompletionToAssistantMessage(chatResponse, model)
      return
    }

    yield {
      type: 'stream_event',
      event: {
        type: 'response.completed',
        response_id: response.id,
      },
    }

    const assistantMessage = outputItemsToAssistantMessage(
      response,
      model,
    )
    yield assistantMessage

    const incompleteReason =
      typeof response.incomplete_details === 'object' &&
      response.incomplete_details &&
      'reason' in (response.incomplete_details as Record<string, unknown>)
        ? String(
            (response.incomplete_details as Record<string, unknown>).reason,
          )
        : null
    if (incompleteReason === 'max_output_tokens') {
      yield createAssistantAPIErrorMessage({
        content:
          'OpenAI response exceeded the configured max output tokens for this request.',
        apiError: 'max_output_tokens',
        error: 'max_output_tokens',
      })
    }
  } catch (error) {
    logForDebugging(
      `[OpenAI] Request failed: ${errorMessage(error)}`,
      { level: 'error' },
    )
    yield createAssistantAPIErrorMessage({
      content: `OpenAI API error: ${errorMessage(error)}`,
    })
  }
}

export async function queryOpenAIModelWithoutStreaming(args: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  let assistantMessage: AssistantMessage | undefined
  for await (const message of queryOpenAIModelWithStreaming(args)) {
    if (message.type === 'assistant') {
      assistantMessage = message as AssistantMessage
    }
  }
  if (!assistantMessage) {
    throw new Error('No assistant message returned by OpenAI provider')
  }
  return assistantMessage
}

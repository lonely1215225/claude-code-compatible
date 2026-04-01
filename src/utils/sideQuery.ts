import type Anthropic from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../constants/system.js'
import { logEvent } from '../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/metadata.js'
import { getAPIMetadata } from '../services/api/claude.js'
import { getGeminiClient } from '../services/api/geminiClient.js'
import { getAnthropicClient } from '../services/api/client.js'
import {
  getOpenAIAPIMode,
  getOpenAIClient,
} from '../services/api/openaiClient.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { computeFingerprint } from './fingerprint.js'
import { safeParseJSON } from './json.js'
import { normalizeModelStringForAPI } from './model/model.js'
import {
  usesGeminiTransport,
  usesOpenAITransport,
} from './model/providers.js'
import { jsonStringify } from './slowOperations.js'

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat
type BetaThinkingConfigParam = Anthropic.Beta.Messages.BetaThinkingConfigParam

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlockParam block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: MessageParam[]
  /** Optional tools (supports both standard Tool[] and BetaToolUnion[] for custom tool types) */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries (default: 2) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in tengu_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
}

/**
 * Extract text from first user message for fingerprint computation.
 */
function extractFirstUserMessageText(messages: MessageParam[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (!firstUserMessage) return ''

  const content = firstUserMessage.content
  if (typeof content === 'string') return content

  // Array of content blocks - find first text block
  const textBlock = content.find(block => block.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

function toOpenAIInputText(text: string): Record<string, unknown> {
  return { type: 'input_text', text }
}

function serializeOpenAIContent(content: unknown): string {
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

function sideQueryMessageToOpenAIItems(message: MessageParam): Array<Record<string, unknown>> {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: String(message.content) }]
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const items: Array<Record<string, unknown>> = []
  const bufferedText: string[] = []

  const flushBufferedText = () => {
    if (bufferedText.length === 0) {
      return
    }
    items.push({
      type: 'message',
      role,
      content: bufferedText.map(text => toOpenAIInputText(text)),
    })
    bufferedText.length = 0
  }

  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      continue
    }

    if (block.type === 'tool_result' && role === 'user') {
      flushBufferedText()
      items.push({
        type: 'function_call_output',
        call_id:
          'tool_use_id' in block && typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : `call_${Math.random().toString(36).slice(2)}`,
        output: serializeOpenAIContent('content' in block ? block.content : ''),
      })
      continue
    }

    if (block.type === 'tool_use' && role === 'assistant') {
      flushBufferedText()
      items.push({
        type: 'function_call',
        call_id:
          'id' in block && typeof block.id === 'string'
            ? block.id
            : `call_${Math.random().toString(36).slice(2)}`,
        name: 'name' in block ? String(block.name) : 'unknown_tool',
        arguments: jsonStringify('input' in block ? block.input : {}),
      })
      continue
    }

    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      bufferedText.push(block.text)
      continue
    }

    bufferedText.push(serializeOpenAIContent(block))
  }

  flushBufferedText()
  return items
}

function mapOpenAISideQueryTools(tools?: Tool[] | BetaToolUnion[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }
  return tools
    .filter((tool): tool is Tool => 'input_schema' in tool)
    .map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      ...(tool.strict ? { strict: true } : {}),
    }))
}

function mapOpenAISideQueryToolChoice(toolChoice?: ToolChoice): unknown {
  if (!toolChoice) {
    return undefined
  }
  if (toolChoice.type === 'auto') {
    return 'auto'
  }
  if (toolChoice.type === 'tool') {
    return { type: 'function', name: toolChoice.name }
  }
  return undefined
}

function mapOpenAIOutputFormat(
  outputFormat?: BetaJSONOutputFormat,
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

function mapOpenAIChatOutputFormat(
  outputFormat?: BetaJSONOutputFormat,
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

function sideQueryMessageToOpenAIChatMessages(
  message: MessageParam,
): Array<Record<string, unknown>> {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: String(message.content) }]
  const out: Array<Record<string, unknown>> = []
  const bufferedText: string[] = []

  if (message.role === 'assistant') {
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
            'id' in block && typeof block.id === 'string'
              ? block.id
              : `call_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: {
            name: 'name' in block ? String(block.name) : 'unknown_tool',
            arguments: jsonStringify('input' in block ? block.input : {}),
          },
        })
      }
    }
    if (bufferedText.length > 0 || toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: bufferedText.length > 0 ? bufferedText.join('\n') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
    return out
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
        out.push({
          role: 'user',
          content: bufferedText.join('\n'),
        })
        bufferedText.length = 0
      }
      out.push({
        role: 'tool',
        tool_call_id:
          'tool_use_id' in block && typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : `call_${Math.random().toString(36).slice(2)}`,
        content: serializeOpenAIContent('content' in block ? block.content : ''),
      })
    }
  }

  if (bufferedText.length > 0) {
    out.push({
      role: 'user',
      content: bufferedText.join('\n'),
    })
  }
  return out
}

function mapOpenAIChatTools(
  tools?: Tool[] | BetaToolUnion[],
): Array<Record<string, unknown>> | undefined {
  const mapped = mapOpenAISideQueryTools(tools)
  if (!mapped) {
    return undefined
  }
  return mapped.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict ? { strict: true } : {}),
    },
  }))
}

function mapOpenAIChatToolChoice(toolChoice?: ToolChoice): unknown {
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

function chatResponseToBetaMessageLike(
  response: Record<string, unknown>,
  model: string,
): BetaMessage {
  const choices = Array.isArray(response.choices)
    ? (response.choices as Array<Record<string, unknown>>)
    : []
  const choice = choices[0] ?? {}
  const message = (choice.message ?? {}) as Record<string, unknown>
  const content: Array<Record<string, unknown>> = []

  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content })
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
        typeof toolCall.id === 'string'
          ? toolCall.id
          : `call_${Math.random().toString(36).slice(2)}`,
      name: typeof fn.name === 'string' ? fn.name : 'unknown_tool',
      input: safeParseJSON(rawArgs) ?? { _raw: rawArgs },
    })
  }

  const usage =
    response.usage && typeof response.usage === 'object'
      ? (response.usage as Record<string, unknown>)
      : {}

  return {
    id:
      typeof response.id === 'string'
        ? response.id
        : `chatcmpl_${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    type: 'message',
    model,
    content: content as BetaMessage['content'],
    usage: createOpenAISideQueryUsage({
      input_tokens:
        typeof usage.prompt_tokens === 'number'
          ? usage.prompt_tokens
          : typeof usage.input_tokens === 'number'
            ? usage.input_tokens
            : 0,
      output_tokens:
        typeof usage.completion_tokens === 'number'
          ? usage.completion_tokens
          : typeof usage.output_tokens === 'number'
            ? usage.output_tokens
            : 0,
    }) as BetaMessage['usage'],
    stop_reason: content.some(block => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    stop_sequence: null,
  } as BetaMessage
}

function sideQueryMessagesToGeminiContents(
  messages: MessageParam[],
): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = []
  const toolNamesById = new Map<string, string>()
  for (const message of messages) {
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: String(message.content) }]
    const role = message.role === 'assistant' ? 'model' : 'user'
    const bufferedText: string[] = []

    const flushBuffered = () => {
      if (bufferedText.length === 0) {
        return
      }
      contents.push({
        role,
        parts: bufferedText.map(text => ({ text })),
      })
      bufferedText.length = 0
    }

    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        continue
      }
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        bufferedText.push(block.text)
        continue
      }
      if (block.type === 'tool_use' && role === 'model') {
        flushBuffered()
        const id =
          'id' in block && typeof block.id === 'string'
            ? block.id
            : `call_${Math.random().toString(36).slice(2)}`
        const name = 'name' in block ? String(block.name) : 'unknown_tool'
        toolNamesById.set(id, name)
        contents.push({
          role: 'model',
          parts: [
            {
              functionCall: {
                id,
                name,
                args: 'input' in block ? block.input : {},
              },
            },
          ],
        })
        continue
      }
      if (block.type === 'tool_result' && role === 'user') {
        flushBuffered()
        const toolUseId =
          'tool_use_id' in block && typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : `call_${Math.random().toString(36).slice(2)}`
        const rawContent = 'content' in block ? block.content : ''
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: toolUseId,
                name: toolNamesById.get(toolUseId) || 'unknown_tool',
                response:
                  typeof rawContent === 'string'
                    ? safeParseJSON(rawContent) ?? { result: rawContent }
                    : rawContent,
              },
            },
          ],
        })
      }
    }
    flushBuffered()
  }
  return contents
}

function mapGeminiSideQueryTools(
  tools?: Tool[] | BetaToolUnion[],
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }
  const declarations = tools
    .filter((tool): tool is Tool => 'input_schema' in tool)
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.input_schema,
    }))
  return declarations.length > 0
    ? [{ functionDeclarations: declarations }]
    : undefined
}

function geminiResponseToBetaMessageLike(
  response: Record<string, unknown>,
  model: string,
): BetaMessage {
  const content: Array<Record<string, unknown>> = []
  if (typeof response.text === 'string' && response.text.length > 0) {
    content.push({ type: 'text', text: response.text })
  }
  const functionCalls = Array.isArray(response.functionCalls)
    ? (response.functionCalls as Array<Record<string, unknown>>)
    : []
  for (const functionCall of functionCalls) {
    content.push({
      type: 'tool_use',
      id:
        typeof functionCall.id === 'string'
          ? functionCall.id
          : `call_${Math.random().toString(36).slice(2)}`,
      name:
        typeof functionCall.name === 'string'
          ? functionCall.name
          : 'unknown_tool',
      input:
        functionCall.args && typeof functionCall.args === 'object'
          ? functionCall.args
          : {},
    })
  }
  const usage =
    response.usageMetadata && typeof response.usageMetadata === 'object'
      ? (response.usageMetadata as Record<string, unknown>)
      : {}
  return {
    id:
      typeof response.responseId === 'string'
        ? response.responseId
        : `gemini_${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    type: 'message',
    model,
    content: content as BetaMessage['content'],
    usage: createOpenAISideQueryUsage({
      input_tokens:
        typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0,
      output_tokens:
        typeof usage.candidatesTokenCount === 'number'
          ? usage.candidatesTokenCount
          : 0,
    }) as BetaMessage['usage'],
    stop_reason: content.some(block => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    stop_sequence: null,
  } as BetaMessage
}

function createOpenAISideQueryUsage(usage: unknown): Record<string, unknown> {
  const u = (usage ?? {}) as Record<string, unknown>
  return {
    input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function responseToBetaMessageLike(
  response: Record<string, unknown>,
  model: string,
): BetaMessage {
  const output = Array.isArray(response.output)
    ? (response.output as Array<Record<string, unknown>>)
    : []
  const content: Array<Record<string, unknown>> = []

  for (const item of output) {
    if (item.type === 'message' && item.role === 'assistant') {
      const parts = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : []
      for (const part of parts) {
        if ('text' in part && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text })
        }
      }
      continue
    }
    if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id:
          typeof item.call_id === 'string'
            ? item.call_id
            : `call_${Math.random().toString(36).slice(2)}`,
        name: typeof item.name === 'string' ? item.name : 'unknown_tool',
        input:
          typeof item.arguments === 'string'
            ? safeParseJSON(item.arguments) ?? { _raw: item.arguments }
            : (item.arguments ?? {}),
      })
    }
  }

  if (
    content.length === 0 &&
    typeof response.output_text === 'string' &&
    response.output_text.length > 0
  ) {
    content.push({ type: 'text', text: response.output_text })
  }

  return {
    id:
      typeof response.id === 'string'
        ? response.id
        : `resp_${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    type: 'message',
    model,
    content: content as BetaMessage['content'],
    usage: createOpenAISideQueryUsage(response.usage) as BetaMessage['usage'],
    stop_reason: content.some(block => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    stop_sequence: null,
  } as BetaMessage
}

/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Use this instead of direct client.beta.messages.create() calls to ensure
 * proper OAuth token validation with fingerprint attribution headers.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips [1m] suffix for API)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  const client = await getAnthropicClient({
    maxRetries,
    model,
    source: 'side_query',
  })
  const betas = [...getModelBetas(model)]
  // Add structured-outputs beta if using output_format and provider supports it
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Extract first user message text for fingerprint
  const messageText = extractFirstUserMessageText(messages)

  // Compute fingerprint for OAuth attribution
  const fingerprint = computeFingerprint(messageText, MACRO.VERSION)
  const attributionHeader = getAttributionHeader(fingerprint)

  // Build system as array to keep attribution header in its own block
  // (prevents server-side parsing from including system content in cc_entrypoint)
  const systemBlocks: TextBlockParam[] = [
    attributionHeader ? { type: 'text', text: attributionHeader } : null,
    // Skip CLI system prompt prefix for internal classifiers that provide their own prompt
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlockParam => block !== null)

  let thinkingConfig: BetaThinkingConfigParam | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budget_tokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const normalizedModel = normalizeModelStringForAPI(model)
  if (usesOpenAITransport()) {
    const client = getOpenAIClient({
      maxRetries,
    })
    if (getOpenAIAPIMode() === 'chat_completions') {
      const response = (await client.chat.completions.create(
        {
          model: normalizedModel,
          messages: [
            {
              role: 'system',
              content: systemBlocks.map(block => block.text).join('\n\n'),
            },
            ...messages.flatMap(sideQueryMessageToOpenAIChatMessages),
          ] as never,
          ...(mapOpenAIChatTools(tools)
            ? { tools: mapOpenAIChatTools(tools) as never }
            : {}),
          ...(mapOpenAIChatToolChoice(tool_choice)
            ? { tool_choice: mapOpenAIChatToolChoice(tool_choice) as never }
            : {}),
          ...(output_format
            ? { response_format: mapOpenAIChatOutputFormat(output_format) as never }
            : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          max_completion_tokens: max_tokens,
        },
        { signal },
      )) as unknown as Record<string, unknown>
      return chatResponseToBetaMessageLike(response, normalizedModel)
    }

    const input = messages.flatMap(sideQueryMessageToOpenAIItems)
    const response = (await client.responses.create(
      {
        model: normalizedModel,
        instructions: systemBlocks.map(block => block.text).join('\n\n'),
        input,
        ...(mapOpenAISideQueryTools(tools)
          ? { tools: mapOpenAISideQueryTools(tools) }
          : {}),
        ...(mapOpenAISideQueryToolChoice(tool_choice)
          ? { tool_choice: mapOpenAISideQueryToolChoice(tool_choice) }
          : {}),
        ...(output_format
          ? { text: mapOpenAIOutputFormat(output_format) }
          : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(thinking !== undefined && thinking !== false
          ? { reasoning: { effort: 'medium' } }
          : {}),
        max_output_tokens: max_tokens,
        parallel_tool_calls: true,
      },
      { signal },
    )) as unknown as Record<string, unknown>
    return responseToBetaMessageLike(response, normalizedModel)
  }
  if (usesGeminiTransport()) {
    const client = getGeminiClient()
    const response = (await client.models.generateContent({
      model: normalizedModel,
      contents: sideQueryMessagesToGeminiContents(messages),
      config: {
        systemInstruction: systemBlocks.map(block => block.text).join('\n\n'),
        ...(mapGeminiSideQueryTools(tools)
          ? { tools: mapGeminiSideQueryTools(tools) }
          : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        maxOutputTokens: max_tokens,
      },
    }, {
      signal,
    } as never)) as unknown as Record<string, unknown>
    return geminiResponseToBetaMessageLike(response, normalizedModel)
  }

  const start = Date.now()
  // biome-ignore lint/plugin: this IS the wrapper that handles OAuth attribution
  const response = await client.beta.messages.create(
    {
      model: normalizedModel,
      max_tokens,
      system: systemBlocks,
      messages,
      ...(tools && { tools }),
      ...(tool_choice && { tool_choice }),
      ...(output_format && { output_config: { format: output_format } }),
      ...(temperature !== undefined && { temperature }),
      ...(stop_sequences && { stop_sequences }),
      ...(thinkingConfig && { thinking: thinkingConfig }),
      ...(betas.length > 0 && { betas }),
      metadata: getAPIMetadata(),
    },
    { signal },
  )

  const requestId =
    (response as { _request_id?: string | null })._request_id ?? undefined
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId:
      requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return response
}

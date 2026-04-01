import { randomUUID } from 'crypto'
import type { Tool, Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
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
import type { Options } from './claude.js'
import { getGeminiClient } from './geminiClient.js'

type GeminiContent = {
  role: 'user' | 'model'
  parts: Array<Record<string, unknown>>
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

function normalizeToolResultPayload(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') {
    const parsed = safeParseJSON(content)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
    return { result: content }
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>
  }
  return { result: normalizeToolResultContent(content) }
}

function pushBufferedParts(
  contents: GeminiContent[],
  role: 'user' | 'model',
  bufferedText: string[],
): void {
  if (bufferedText.length === 0) {
    return
  }
  contents.push({
    role,
    parts: bufferedText.map(text => ({ text })),
  })
  bufferedText.length = 0
}

function buildGeminiContents(messages: Message[], tools: Tools): GeminiContent[] {
  const normalizedMessages = normalizeMessagesForAPI(messages, tools)
  const contents: GeminiContent[] = []
  const toolNamesById = new Map<string, string>()

  for (const message of normalizedMessages) {
    if (message.type !== 'assistant' && message.type !== 'user') {
      continue
    }
    const content = Array.isArray(message.message?.content)
      ? message.message.content
      : typeof message.message?.content === 'string'
        ? [{ type: 'text', text: message.message.content }]
        : []

    const role = message.type === 'assistant' ? 'model' : 'user'
    const bufferedText: string[] = []

    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        continue
      }
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        bufferedText.push(block.text)
        continue
      }
      if (block.type === 'tool_use' && role === 'model') {
        pushBufferedParts(contents, 'model', bufferedText)
        const id =
          'id' in block && typeof block.id === 'string' ? block.id : randomUUID()
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
        pushBufferedParts(contents, 'user', bufferedText)
        const toolUseId =
          'tool_use_id' in block && typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : randomUUID()
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: toolUseId,
                name: toolNamesById.get(toolUseId) || 'unknown_tool',
                response: normalizeToolResultPayload(
                  'content' in block ? block.content : undefined,
                ),
              },
            },
          ],
        })
      }
    }

    pushBufferedParts(contents, role, bufferedText)
  }

  return contents
}

async function buildGeminiTools(
  tools: Tools,
  options: Options,
): Promise<Array<Record<string, unknown>>> {
  const declarations: Array<Record<string, unknown>> = []
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
    }
    declarations.push({
      name: schema.name,
      description: schema.description,
      parametersJsonSchema: schema.input_schema,
    })
  }
  return declarations.length > 0
    ? [
        {
          functionDeclarations: declarations,
        },
      ]
    : []
}

function mapGeminiToolConfig(toolChoice: Options['toolChoice']): Record<string, unknown> | undefined {
  if (!toolChoice) {
    return undefined
  }
  if (toolChoice.type === 'auto') {
    return {
      functionCallingConfig: {
        mode: 'AUTO',
      },
    }
  }
  if (toolChoice.type === 'tool') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.name],
      },
    }
  }
  return undefined
}

function createGeminiUsage(response: Record<string, unknown>): Record<string, unknown> {
  const usage =
    response.usageMetadata && typeof response.usageMetadata === 'object'
      ? (response.usageMetadata as Record<string, unknown>)
      : {}
  return {
    input_tokens:
      typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0,
    output_tokens:
      typeof usage.candidatesTokenCount === 'number'
        ? usage.candidatesTokenCount
        : 0,
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

function geminiResponseText(response: Record<string, unknown>): string {
  if (typeof response.text === 'string') {
    return response.text
  }
  if (Array.isArray(response.candidates)) {
    for (const candidate of response.candidates as Array<Record<string, unknown>>) {
      const content =
        candidate.content && typeof candidate.content === 'object'
          ? (candidate.content as Record<string, unknown>)
          : null
      const parts = content && Array.isArray(content.parts) ? content.parts : []
      const text = parts
        .map(part =>
          part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
            ? part.text
            : '',
        )
        .filter(Boolean)
        .join('\n')
      if (text) {
        return text
      }
    }
  }
  return ''
}

function geminiResponseToAssistantMessage(
  response: Record<string, unknown>,
  model: string,
): AssistantMessage {
  const content: Array<Record<string, unknown>> = []

  const functionCalls = Array.isArray(response.functionCalls)
    ? (response.functionCalls as Array<Record<string, unknown>>)
    : []
  for (const functionCall of functionCalls) {
    content.push({
      type: 'tool_use',
      id:
        typeof functionCall.id === 'string'
          ? functionCall.id
          : `call_${randomUUID()}`,
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

  const text = geminiResponseText(response)
  if (text) {
    content.unshift({
      type: 'text',
      text,
    })
  }

  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId:
      typeof response.responseId === 'string'
        ? response.responseId
        : typeof response.id === 'string'
          ? response.id
          : undefined,
    message: {
      id:
        typeof response.responseId === 'string'
          ? response.responseId
          : `gemini_${randomUUID()}`,
      role: 'assistant',
      type: 'message',
      model,
      content,
      usage: createGeminiUsage(response),
      stop_reason: functionCalls.length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      context_management: null,
    },
  }
}

export async function* queryGeminiModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig: _thinkingConfig,
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
    const client = getGeminiClient()
    const model = normalizeModelStringForAPI(options.model)
    const contents = buildGeminiContents(messages, tools)
    const geminiTools = await buildGeminiTools(tools, options)
    const response = (await client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt.join('\n\n'),
        ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
        ...(mapGeminiToolConfig(options.toolChoice)
          ? { toolConfig: mapGeminiToolConfig(options.toolChoice) }
          : {}),
        ...(options.maxOutputTokensOverride
          ? { maxOutputTokens: options.maxOutputTokensOverride }
          : {}),
        ...(options.temperatureOverride !== undefined
          ? { temperature: options.temperatureOverride }
          : {}),
      },
    }, {
      signal,
    } as never)) as unknown as Record<string, unknown>

    yield {
      type: 'stream_event',
      event: {
        type: 'response.completed',
        response_id:
          typeof response.responseId === 'string'
            ? response.responseId
            : typeof response.id === 'string'
              ? response.id
              : randomUUID(),
      },
    }

    yield geminiResponseToAssistantMessage(response, model)
  } catch (error) {
    logForDebugging(`[Gemini] Request failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    yield createAssistantAPIErrorMessage({
      content: `Gemini API error: ${errorMessage(error)}`,
    })
  }
}

export async function queryGeminiModelWithoutStreaming(args: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  let assistantMessage: AssistantMessage | undefined
  for await (const message of queryGeminiModelWithStreaming(args)) {
    if (message.type === 'assistant') {
      assistantMessage = message as AssistantMessage
    }
  }
  if (!assistantMessage) {
    throw new Error('No assistant message returned by Gemini provider')
  }
  return assistantMessage
}

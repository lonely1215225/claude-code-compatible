import OpenAI from 'openai'
import { getSessionId } from '../../bootstrap/state.js'
import { getUserAgent } from '../../utils/http.js'

export function getOpenAIBaseUrl(): string | undefined {
  return process.env.OPENAI_BASE_URL || undefined
}

export function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL || 'gpt-5.4'
}

export function getOpenAISmallFastModel(): string {
  return process.env.OPENAI_SMALL_FAST_MODEL || getOpenAIModel()
}

export function getOpenAIAPIMode(): 'responses' | 'chat_completions' {
  return process.env.OPENAI_API_MODE === 'chat_completions'
    ? 'chat_completions'
    : 'responses'
}

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY || undefined
}

export function getOpenAIClient({
  maxRetries = 2,
  fetchOverride,
}: {
  maxRetries?: number
  fetchOverride?: typeof fetch
} = {}): OpenAI {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required when CLAUDE_CODE_USE_OPENAI=1',
    )
  }

  return new OpenAI({
    apiKey,
    baseURL: getOpenAIBaseUrl(),
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    defaultHeaders: {
      'User-Agent': getUserAgent(),
      'X-Claude-Code-Session-Id': getSessionId(),
    },
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  })
}

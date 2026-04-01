import {
  getAPIProvider,
  getProviderValidationMode,
} from '../../utils/model/providers.js'
import {
  getGeminiApiKey,
  getGeminiBaseUrl,
  getGeminiModel,
} from './geminiClient.js'
import { generateGeminiContentViaPython } from './geminiRest.js'
import {
  getOpenAIAPIMode,
  getOpenAIClient,
  getOpenAIModel,
} from './openaiClient.js'

const OPENAI_VALIDATION_OUTPUT_TOKENS = 16
const DEFAULT_PROVIDER_VALIDATION_TIMEOUT_MS = getDefaultProviderValidationTimeoutMs()

function shouldFallbackOpenAIResponsesValidation(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes("invalid value: 'input_text'") ||
    (message.includes('input_text') &&
      message.includes('supported values are') &&
      message.includes('output_text'))
  )
}

export type ProviderValidationResult = {
  provider: ReturnType<typeof getAPIProvider>
  status: 'validated' | 'skipped'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Provider validation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function getDefaultProviderValidationTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_PROVIDER_VALIDATION_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000
}

export async function validateConfiguredProvider({
  timeoutMs = DEFAULT_PROVIDER_VALIDATION_TIMEOUT_MS,
}: {
  timeoutMs?: number
} = {}): Promise<ProviderValidationResult> {
  const provider = getAPIProvider()
  const validationMode = getProviderValidationMode(provider)

  if (validationMode === 'openai') {
    const client = getOpenAIClient({ maxRetries: 0 })
    if (getOpenAIAPIMode() === 'chat_completions') {
      await withTimeout(
        client.chat.completions.create({
          model: getOpenAIModel(),
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: OPENAI_VALIDATION_OUTPUT_TOKENS,
        }),
        timeoutMs,
      )
      return { provider, status: 'validated' }
    }

    try {
      await withTimeout(
        client.responses.create({
          model: getOpenAIModel(),
          input: 'ping',
          max_output_tokens: OPENAI_VALIDATION_OUTPUT_TOKENS,
        }),
        timeoutMs,
      )
    } catch (error) {
      if (!shouldFallbackOpenAIResponsesValidation(error)) {
        throw error
      }
      await withTimeout(
        client.chat.completions.create({
          model: getOpenAIModel(),
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: OPENAI_VALIDATION_OUTPUT_TOKENS,
        }),
        timeoutMs,
      )
    }
    return { provider, status: 'validated' }
  }

  if (validationMode === 'gemini') {
    const apiKey = getGeminiApiKey()
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY or GOOGLE_API_KEY is required when CLAUDE_CODE_USE_GEMINI=1',
      )
    }
    await withTimeout(
      generateGeminiContentViaPython({
        apiKey,
        baseUrl: getGeminiBaseUrl(),
        model: getGeminiModel(),
        body: {
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: {
            maxOutputTokens: 4,
          },
        },
      }),
      timeoutMs,
    )
    return { provider, status: 'validated' }
  }

  return { provider, status: 'skipped' }
}

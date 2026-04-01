import {
  getAPIProvider,
  getProviderValidationMode,
} from '../../utils/model/providers.js'
import { getGeminiClient, getGeminiModel } from './geminiClient.js'
import {
  getOpenAIAPIMode,
  getOpenAIClient,
  getOpenAIModel,
} from './openaiClient.js'

const OPENAI_VALIDATION_OUTPUT_TOKENS = 16

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

export async function validateConfiguredProvider({
  timeoutMs = 10000,
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

    await withTimeout(
      client.responses.create({
        model: getOpenAIModel(),
        input: 'ping',
        max_output_tokens: OPENAI_VALIDATION_OUTPUT_TOKENS,
      }),
      timeoutMs,
    )
    return { provider, status: 'validated' }
  }

  if (validationMode === 'gemini') {
    const client = getGeminiClient()
    await withTimeout(
      client.models.generateContent({
        model: getGeminiModel(),
        contents: 'ping',
        config: {
          maxOutputTokens: 4,
        },
      }),
      timeoutMs,
    )
    return { provider, status: 'validated' }
  }

  return { provider, status: 'skipped' }
}

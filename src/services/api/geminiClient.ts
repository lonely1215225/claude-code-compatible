import { GoogleGenAI } from '@google/genai'

export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined
}

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash'
}

export function getGeminiSmallFastModel(): string {
  return process.env.GEMINI_SMALL_FAST_MODEL || getGeminiModel()
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiApiKey()
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY or GOOGLE_API_KEY is required when CLAUDE_CODE_USE_GEMINI=1',
    )
  }

  return new GoogleGenAI({
    apiKey,
  })
}

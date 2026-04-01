import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai'
import { isEnvTruthy } from '../../utils/envUtils.js'

export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined
}

export function getGeminiBaseUrl(): string | undefined {
  return process.env.GEMINI_BASE_URL || undefined
}

export function getGeminiApiVersion(): string | undefined {
  return process.env.GEMINI_API_VERSION || process.env.GOOGLE_GENAI_API_VERSION || undefined
}

export function getGeminiUsesVertexAI(): boolean {
  return isEnvTruthy(
    process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GEMINI_USE_VERTEXAI,
  )
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

  const options: GoogleGenAIOptions = {
    apiKey,
  }
  const baseUrl = getGeminiBaseUrl()
  const apiVersion = getGeminiApiVersion()

  if (baseUrl) {
    options.httpOptions = {
      baseUrl,
    }
  }
  if (apiVersion) {
    options.apiVersion = apiVersion
  }
  if (getGeminiUsesVertexAI()) {
    options.vertexai = true

    const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_PROJECT
    const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GEMINI_LOCATION

    if (project) {
      options.project = project
    }
    if (location) {
      options.location = location
    }
  }

  return new GoogleGenAI(options)
}

import OpenAI from 'openai'
import { getSessionId } from '../../bootstrap/state.js'
import { getUserAgent } from '../../utils/http.js'
import { listGeminiModelsViaPython } from './geminiRest.js'

const MODEL_DISCOVERY_TIMEOUT_MS = 5000
const SUGGESTED_OPENAI_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4o-mini',
  'o4-mini',
  'gpt-3.5-turbo',
] as const
const GEMINI_MODEL_PREFIX_RE =
  /^(?:models\/|publishers\/[^/]+\/models\/|projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/)/
const SUGGESTED_GEMINI_MODEL_IDS = [
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const

export type DiscoveredProviderModel = {
  id: string
  label: string
  description?: string
}

function sortModels(
  models: DiscoveredProviderModel[],
  currentModel?: string,
): DiscoveredProviderModel[] {
  const deduped = Array.from(new Map(models.map(model => [model.id, model])).values())
  return deduped.sort((left, right) => {
    if (currentModel) {
      if (left.id === currentModel) return -1
      if (right.id === currentModel) return 1
    }
    return right.id.localeCompare(left.id)
  })
}

function normalizeGeminiModelId(name: string): string {
  return name.replace(GEMINI_MODEL_PREFIX_RE, '')
}

function withDiscoveryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error(`Model discovery timed out after ${timeoutMs}ms`))
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

export async function discoverOpenAIModels({
  apiKey,
  baseUrl,
  currentModel,
}: {
  apiKey: string
  baseUrl?: string
  currentModel?: string
}): Promise<DiscoveredProviderModel[]> {
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: MODEL_DISCOVERY_TIMEOUT_MS,
    defaultHeaders: {
      'User-Agent': getUserAgent(),
      'X-Claude-Code-Session-Id': getSessionId(),
    },
  })

  const page = await withDiscoveryTimeout(client.models.list(), MODEL_DISCOVERY_TIMEOUT_MS)
  const models = page.data
    .filter(model => typeof model.id === 'string' && model.id.length > 0)
    .map(model => ({
      id: model.id,
      label: model.id,
      description:
        typeof model.owned_by === 'string' && model.owned_by.length > 0
          ? `Owner: ${model.owned_by}`
          : undefined,
    }))

  return sortModels(models, currentModel)
}

export function getSuggestedOpenAIModels(
  currentModel?: string,
): DiscoveredProviderModel[] {
  const models = SUGGESTED_OPENAI_MODEL_IDS.map(id => ({
    id,
    label: id,
    description: 'Suggested OpenAI-compatible model',
  }))

  if (
    currentModel &&
    !models.some(model => model.id === currentModel) &&
    currentModel.length > 0
  ) {
    models.unshift({
      id: currentModel,
      label: currentModel,
      description: 'Current configured OpenAI-compatible model',
    })
  }

  return sortModels(models, currentModel)
}

export async function discoverGeminiModels({
  apiKey,
  baseUrl,
  currentModel,
}: {
  apiKey: string
  baseUrl?: string
  currentModel?: string
}): Promise<DiscoveredProviderModel[]> {
  const response = await listGeminiModelsViaPython({
    apiKey,
    baseUrl,
    timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
  })

  const models = (Array.isArray(response.models) ? response.models : [])
    .filter(model => {
      const record = model as Record<string, unknown>
      const id =
        typeof record.name === 'string' ? normalizeGeminiModelId(record.name) : ''
      if (!id || !id.startsWith('gemini')) {
        return false
      }
      const supportedActions = Array.isArray(record.supportedActions)
        ? record.supportedActions
        : []
      return (
        supportedActions.length === 0 ||
        supportedActions.some(
          action =>
            typeof action === 'string' &&
            ['generateContent', 'generateText', 'createCachedContent'].includes(action),
        )
      )
    })
    .map(model => {
      const record = model as Record<string, unknown>
      const id = typeof record.name === 'string' ? normalizeGeminiModelId(record.name) : ''
      return {
        id,
        label: id,
        description:
          typeof record.displayName === 'string' && record.displayName.length > 0
            ? record.displayName
            : typeof record.description === 'string' && record.description.length > 0
              ? record.description
              : undefined,
      }
    })

  return sortModels(models, currentModel)
}

export function getSuggestedGeminiModels(
  currentModel?: string,
): DiscoveredProviderModel[] {
  const models = SUGGESTED_GEMINI_MODEL_IDS.map(id => ({
    id,
    label: id,
    description: 'Suggested Gemini model',
  }))

  if (
    currentModel &&
    !models.some(model => model.id === currentModel) &&
    currentModel.startsWith('gemini')
  ) {
    models.unshift({
      id: currentModel,
      label: currentModel,
      description: 'Current configured Gemini model',
    })
  }

  return sortModels(models, currentModel)
}

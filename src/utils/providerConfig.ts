import { getSettingsForSource, updateSettingsForSource } from './settings/settings.js'
import {
  getAPIProviderFromEnv,
  getConfigurableProviderForAPIProvider,
  getCurrentConfigurableProvider,
  getInteractiveProviderDescriptors,
  type ConfigurableProvider,
  type ProviderDescriptor,
} from './model/providers.js'
export type { ConfigurableProvider } from './model/providers.js'

export type ProviderConfigValues = {
  provider: ConfigurableProvider
  apiKey?: string
  baseUrl?: string
  model?: string
  apiMode?: 'responses' | 'chat_completions'
}

export const PROVIDER_OPTIONS: Array<{
  value: ConfigurableProvider
  label: string
  description: string
}> = (['openai', 'gemini', 'anthropic'] as const)
  .map(
    provider =>
      getInteractiveProviderDescriptors().find(
        descriptor => descriptor.setup.configurableProvider === provider,
      ) as ProviderDescriptor | undefined,
  )
  .filter((descriptor): descriptor is ProviderDescriptor => descriptor !== undefined)
  .map(descriptor => ({
    value: descriptor.setup.configurableProvider!,
    label: descriptor.label,
    description: descriptor.description,
  }))

function getUserSettingsEnv(): Record<string, string> {
  const env = getSettingsForSource('userSettings')?.env
  if (!env || typeof env !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, String(value)]),
  )
}

export function getConfiguredProviderFromSettings(): ConfigurableProvider {
  return (
    getConfigurableProviderForAPIProvider(getAPIProviderFromEnv(getUserSettingsEnv())) ||
    'anthropic'
  )
}

export function getConfiguredProviderForSetup(): ConfigurableProvider {
  return getCurrentConfigurableProvider() || getConfiguredProviderFromSettings()
}

export function getProviderDefaultModel(provider: ConfigurableProvider): string {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_MODEL || getUserSettingsEnv().OPENAI_MODEL || 'gpt-5.4'
    case 'gemini':
      return (
        process.env.GEMINI_MODEL ||
        getUserSettingsEnv().GEMINI_MODEL ||
        'gemini-2.5-flash'
      )
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL || 'sonnet'
  }
}

export function getProviderDefaultApiMode(
  provider: ConfigurableProvider,
): 'responses' | 'chat_completions' {
  if (provider !== 'openai') {
    return 'responses'
  }
  const saved = getUserSettingsEnv().OPENAI_API_MODE
  return saved === 'chat_completions' ? 'chat_completions' : 'responses'
}

export function getSavedProviderEnvValue(key: string): string | undefined {
  return process.env[key] || getUserSettingsEnv()[key] || undefined
}

export function persistProviderConfig(values: ProviderConfigValues): {
  error: Error | null
} {
  const currentEnv = getUserSettingsEnv()
  const nextEnv: Record<string, string | undefined> = {
    ...currentEnv,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    CLAUDE_CODE_USE_OPENAI: values.provider === 'openai' ? '1' : undefined,
    CLAUDE_CODE_USE_GEMINI: values.provider === 'gemini' ? '1' : undefined,
  }

  if (values.provider === 'openai') {
    nextEnv.OPENAI_API_KEY = values.apiKey || currentEnv.OPENAI_API_KEY
    nextEnv.OPENAI_BASE_URL = values.baseUrl || undefined
    nextEnv.OPENAI_MODEL = values.model || getProviderDefaultModel('openai')
    nextEnv.OPENAI_API_MODE =
      values.apiMode || getProviderDefaultApiMode('openai')
  } else if (values.provider === 'gemini') {
    nextEnv.GEMINI_API_KEY =
      values.apiKey || currentEnv.GEMINI_API_KEY || currentEnv.GOOGLE_API_KEY
    nextEnv.GOOGLE_API_KEY =
      values.apiKey || currentEnv.GOOGLE_API_KEY || currentEnv.GEMINI_API_KEY
    nextEnv.GEMINI_BASE_URL = undefined
    nextEnv.GOOGLE_GENAI_USE_VERTEXAI = undefined
    nextEnv.GEMINI_USE_VERTEXAI = undefined
    nextEnv.GEMINI_MODEL = values.model || getProviderDefaultModel('gemini')
  } else {
    if (values.baseUrl !== undefined) {
      nextEnv.ANTHROPIC_BASE_URL = values.baseUrl || undefined
    }
    if (values.model) {
      nextEnv.ANTHROPIC_MODEL = values.model
    }
  }

  return updateSettingsForSource('userSettings', {
    env: nextEnv,
  })
}

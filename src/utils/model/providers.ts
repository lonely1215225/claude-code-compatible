import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'

export type ConfigurableProvider = 'anthropic' | 'openai' | 'gemini'

export type ProviderTransport = 'anthropic' | 'openai' | 'gemini'

export type ProviderSetupMode = 'interactive' | 'env'

export type ProviderValidationMode = 'openai' | 'gemini' | 'skip'

export type ProviderDescriptor = {
  id: APIProvider
  label: string
  description: string
  transport: ProviderTransport
  selectionEnvFlag?: string
  setup: {
    mode: ProviderSetupMode
    configurableProvider: ConfigurableProvider | null
    description: string
    docsUrl?: string
  }
  capabilities: {
    filesApi: boolean
    thinking: boolean
    effort: boolean
    fastMode: boolean
    firstPartyExperimentalBetas: boolean
    toolSearchHeader: '1p' | '3p'
  }
  validationMode: ProviderValidationMode
}

const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    description: 'Anthropic models via Amazon Bedrock',
    transport: 'anthropic',
    selectionEnvFlag: 'CLAUDE_CODE_USE_BEDROCK',
    setup: {
      mode: 'env',
      configurableProvider: null,
      description: 'Configured through environment variables or host-managed settings',
      docsUrl: 'https://code.claude.com/docs/en/amazon-bedrock',
    },
    capabilities: {
      filesApi: true,
      thinking: true,
      effort: true,
      fastMode: false,
      firstPartyExperimentalBetas: false,
      toolSearchHeader: '3p',
    },
    validationMode: 'skip',
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    description: 'Anthropic models via Vertex AI',
    transport: 'anthropic',
    selectionEnvFlag: 'CLAUDE_CODE_USE_VERTEX',
    setup: {
      mode: 'env',
      configurableProvider: null,
      description: 'Configured through environment variables or host-managed settings',
      docsUrl: 'https://code.claude.com/docs/en/google-vertex-ai',
    },
    capabilities: {
      filesApi: true,
      thinking: true,
      effort: true,
      fastMode: false,
      firstPartyExperimentalBetas: false,
      toolSearchHeader: '3p',
    },
    validationMode: 'skip',
  },
  {
    id: 'foundry',
    label: 'Azure AI Foundry',
    description: 'Anthropic models via Azure AI Foundry',
    transport: 'anthropic',
    selectionEnvFlag: 'CLAUDE_CODE_USE_FOUNDRY',
    setup: {
      mode: 'env',
      configurableProvider: null,
      description: 'Configured through environment variables or host-managed settings',
      docsUrl: 'https://code.claude.com/docs/en/microsoft-foundry',
    },
    capabilities: {
      filesApi: true,
      thinking: true,
      effort: true,
      fastMode: false,
      firstPartyExperimentalBetas: true,
      toolSearchHeader: '1p',
    },
    validationMode: 'skip',
  },
  {
    id: 'gemini',
    label: 'Gemini official',
    description: 'Google Gemini official API via @google/genai',
    transport: 'gemini',
    selectionEnvFlag: 'CLAUDE_CODE_USE_GEMINI',
    setup: {
      mode: 'interactive',
      configurableProvider: 'gemini',
      description: 'Set API key and default model from the built-in provider wizard',
    },
    capabilities: {
      filesApi: false,
      thinking: false,
      effort: false,
      fastMode: false,
      firstPartyExperimentalBetas: false,
      toolSearchHeader: '1p',
    },
    validationMode: 'gemini',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    description: 'OpenAI official API or OpenAI-compatible base URL',
    transport: 'openai',
    selectionEnvFlag: 'CLAUDE_CODE_USE_OPENAI',
    setup: {
      mode: 'interactive',
      configurableProvider: 'openai',
      description:
        'Set API key, optional base URL, model, and protocol mode from the built-in provider wizard',
    },
    capabilities: {
      filesApi: false,
      thinking: false,
      effort: false,
      fastMode: false,
      firstPartyExperimentalBetas: false,
      toolSearchHeader: '1p',
    },
    validationMode: 'openai',
  },
  {
    id: 'firstParty',
    label: 'Anthropic-compatible',
    description: 'Anthropic first-party or Anthropic-compatible endpoint',
    transport: 'anthropic',
    setup: {
      mode: 'interactive',
      configurableProvider: 'anthropic',
      description:
        'Set the Anthropic base URL and default model from the built-in provider wizard',
    },
    capabilities: {
      filesApi: true,
      thinking: true,
      effort: true,
      fastMode: true,
      firstPartyExperimentalBetas: true,
      toolSearchHeader: '1p',
    },
    validationMode: 'skip',
  },
]

const PROVIDER_DESCRIPTOR_MAP = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map(descriptor => [descriptor.id, descriptor]),
) as Record<APIProvider, ProviderDescriptor>

const PROVIDER_SELECTION_PRIORITY: APIProvider[] = [
  'bedrock',
  'vertex',
  'foundry',
  'gemini',
  'openai',
]

function providerFlagEnabled(
  provider: APIProvider,
  env: Record<string, string | undefined>,
): boolean {
  const selectionEnvFlag = getProviderDescriptor(provider).selectionEnvFlag
  return selectionEnvFlag ? isEnvTruthy(env[selectionEnvFlag]) : false
}

export function getProviderDescriptor(provider: APIProvider): ProviderDescriptor {
  return PROVIDER_DESCRIPTOR_MAP[provider]
}

export function getAllProviderDescriptors(): ProviderDescriptor[] {
  return PROVIDER_DESCRIPTORS
}

export function getInteractiveProviderDescriptors(): ProviderDescriptor[] {
  return PROVIDER_DESCRIPTORS.filter(
    descriptor =>
      descriptor.setup.mode === 'interactive' &&
      descriptor.setup.configurableProvider !== null,
  )
}

export function getAPIProviderFromEnv(
  env: Record<string, string | undefined>,
): APIProvider {
  for (const provider of PROVIDER_SELECTION_PRIORITY) {
    if (providerFlagEnabled(provider, env)) {
      return provider
    }
  }
  return 'firstParty'
}

export function getAPIProvider(): APIProvider {
  return getAPIProviderFromEnv(process.env)
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

export function getProviderLabel(provider: APIProvider): string {
  if (provider === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
    return 'Anthropic'
  }
  return getProviderDescriptor(provider).label
}

export function getCurrentProviderDescriptor(): ProviderDescriptor {
  return getProviderDescriptor(getAPIProvider())
}

export function getCurrentProviderLabel(): string {
  return getProviderLabel(getAPIProvider())
}

export function getConfigurableProviderForAPIProvider(
  provider: APIProvider,
): ConfigurableProvider | null {
  return getProviderDescriptor(provider).setup.configurableProvider
}

export function getCurrentConfigurableProvider(): ConfigurableProvider | null {
  return getConfigurableProviderForAPIProvider(getAPIProvider())
}

export function isConfigurableProvider(
  provider: APIProvider,
): provider is 'firstParty' | 'openai' | 'gemini' {
  return getConfigurableProviderForAPIProvider(provider) !== null
}

export function isProviderInteractive(provider: APIProvider): boolean {
  return getProviderDescriptor(provider).setup.mode === 'interactive'
}

export function usesAnthropicTransport(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return getProviderDescriptor(provider).transport === 'anthropic'
}

export function usesOpenAITransport(provider: APIProvider = getAPIProvider()): boolean {
  return getProviderDescriptor(provider).transport === 'openai'
}

export function usesGeminiTransport(provider: APIProvider = getAPIProvider()): boolean {
  return getProviderDescriptor(provider).transport === 'gemini'
}

export function providerSupportsFilesApi(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return getProviderDescriptor(provider).capabilities.filesApi
}

export function providerSupportsThinkingFamily(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return getProviderDescriptor(provider).capabilities.thinking
}

export function providerSupportsEffortFamily(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return getProviderDescriptor(provider).capabilities.effort
}

export function providerSupportsFastMode(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return getProviderDescriptor(provider).capabilities.fastMode
}

export function providerSupportsFirstPartyExperimentalBetas(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return getProviderDescriptor(provider).capabilities.firstPartyExperimentalBetas
}

export function getProviderToolSearchHeaderFamily(
  provider: APIProvider = getAPIProvider(),
): '1p' | '3p' {
  return getProviderDescriptor(provider).capabilities.toolSearchHeader
}

export function getProviderValidationMode(
  provider: APIProvider = getAPIProvider(),
): ProviderValidationMode {
  return getProviderDescriptor(provider).validationMode
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import {
  getConfiguredProviderForSetup,
  getProviderDefaultApiMode,
  getProviderDefaultModel,
  getSavedProviderEnvValue,
  persistProviderConfig,
  PROVIDER_OPTIONS,
  type ConfigurableProvider,
} from '../utils/providerConfig.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  getAPIProvider,
  getCurrentProviderLabel,
  isProviderInteractive,
} from '../utils/model/providers.js'
import {
  discoverGeminiModels,
  discoverOpenAIModels,
  getSuggestedGeminiModels,
  getSuggestedOpenAIModels,
  type DiscoveredProviderModel,
} from '../services/api/providerModels.js'
import { validateConfiguredProvider } from '../services/api/providerValidation.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/select.js'

type Props = {
  onDone(provider: ConfigurableProvider): void
  onCancel?(): void
}

type WizardStep =
  | 'provider'
  | 'openaiApiKey'
  | 'openaiBaseUrl'
  | 'openaiModel'
  | 'openaiModelManual'
  | 'openaiMode'
  | 'geminiApiKey'
  | 'geminiBaseUrl'
  | 'geminiModel'
  | 'geminiModelManual'
  | 'anthropicBaseUrl'
  | 'anthropicModel'
  | 'confirm'
type ModelDiscoveryState = {
  status: 'idle' | 'loading' | 'loaded' | 'failed'
  models: DiscoveredProviderModel[]
  error: string | null
  requestKey: string | null
}

const MODEL_DISCOVERY_MANUAL_VALUE = '__manual_model__'
const RUNTIME_PROVIDER_FLAG_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
] as const
const INITIAL_MODEL_DISCOVERY_STATE: ModelDiscoveryState = {
  status: 'idle',
  models: [],
  error: null,
  requestKey: null,
}

function discoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resetRuntimeProviderFlags(): void {
  for (const key of RUNTIME_PROVIDER_FLAG_KEYS) {
    delete process.env[key]
  }
}

export function ProviderSetupStep({ onDone, onCancel }: Props): React.ReactNode {
  const initialProvider = useMemo(() => getConfiguredProviderForSetup(), [])
  const runtimeProvider = useMemo(() => getAPIProvider(), [])
  const runtimeProviderLabel = useMemo(() => getCurrentProviderLabel(), [])
  const runtimeProviderIsInteractive = useMemo(
    () => isProviderInteractive(runtimeProvider),
    [runtimeProvider],
  )
  const [provider, setProvider] = useState<ConfigurableProvider>(initialProvider)
  const [step, setStep] = useState<WizardStep>('provider')
  const [error, setError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  const existingOpenAIKey = useMemo(
    () => getSavedProviderEnvValue('OPENAI_API_KEY'),
    [],
  )
  const existingGeminiKey = useMemo(
    () =>
      getSavedProviderEnvValue('GEMINI_API_KEY') ||
      getSavedProviderEnvValue('GOOGLE_API_KEY'),
    [],
  )
  const existingGeminiBaseUrl = useMemo(
    () => getSavedProviderEnvValue('GEMINI_BASE_URL') || '',
    [],
  )
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(
    () => getSavedProviderEnvValue('OPENAI_BASE_URL') || '',
  )
  const [openaiModel, setOpenaiModel] = useState(() =>
    getSavedProviderEnvValue('OPENAI_MODEL') ||
    getProviderDefaultModel('openai'),
  )
  const [openaiMode, setOpenaiMode] = useState<'responses' | 'chat_completions'>(
    () => getProviderDefaultApiMode('openai'),
  )
  const [openaiModelDiscovery, setOpenaiModelDiscovery] = useState<ModelDiscoveryState>(
    INITIAL_MODEL_DISCOVERY_STATE,
  )
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [geminiBaseUrl, setGeminiBaseUrl] = useState(existingGeminiBaseUrl)
  const [geminiModel, setGeminiModel] = useState(() =>
    getSavedProviderEnvValue('GEMINI_MODEL') ||
    getProviderDefaultModel('gemini'),
  )
  const [geminiModelDiscovery, setGeminiModelDiscovery] = useState<ModelDiscoveryState>(
    INITIAL_MODEL_DISCOVERY_STATE,
  )
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState(
    () => getSavedProviderEnvValue('ANTHROPIC_BASE_URL') || '',
  )
  const [anthropicModel, setAnthropicModel] = useState(
    () => getSavedProviderEnvValue('ANTHROPIC_MODEL') || 'sonnet',
  )
  const [cursorOffset, setCursorOffset] = useState(0)
  const resolvedOpenAIKey = openaiApiKey || existingOpenAIKey || ''
  const resolvedGeminiKey = geminiApiKey || existingGeminiKey || ''
  const openaiDiscoveryKey = JSON.stringify([
    resolvedOpenAIKey,
    openaiBaseUrl,
    openaiModel,
  ])
  const geminiDiscoveryKey = JSON.stringify([
    resolvedGeminiKey,
    geminiBaseUrl,
    geminiModel,
  ])
  const suggestedGeminiModels = useMemo(
    () => getSuggestedGeminiModels(geminiModel || undefined),
    [geminiModel],
  )
  const suggestedOpenAIModels = useMemo(
    () => getSuggestedOpenAIModels(openaiModel || undefined),
    [openaiModel],
  )

  useEffect(() => {
    switch (step) {
      case 'openaiApiKey':
        setCursorOffset(openaiApiKey.length)
        break
      case 'openaiBaseUrl':
        setCursorOffset(openaiBaseUrl.length)
        break
      case 'openaiModelManual':
        setCursorOffset(openaiModel.length)
        break
      case 'geminiApiKey':
        setCursorOffset(geminiApiKey.length)
        break
      case 'geminiBaseUrl':
        setCursorOffset(geminiBaseUrl.length)
        break
      case 'geminiModelManual':
        setCursorOffset(geminiModel.length)
        break
      case 'anthropicBaseUrl':
        setCursorOffset(anthropicBaseUrl.length)
        break
      case 'anthropicModel':
        setCursorOffset(anthropicModel.length)
        break
      default:
        setCursorOffset(0)
        break
    }
  }, [
    step,
    openaiApiKey,
    openaiBaseUrl,
    openaiModel,
    geminiApiKey,
    geminiBaseUrl,
    geminiModel,
    anthropicBaseUrl,
    anthropicModel,
  ])

  useEffect(() => {
    if (step !== 'openaiModel') {
      return
    }
    if (!resolvedOpenAIKey) {
      if (
        openaiModelDiscovery.requestKey === openaiDiscoveryKey &&
        openaiModelDiscovery.status === 'failed'
      ) {
        return
      }
      setOpenaiModelDiscovery({
        status: 'failed',
        models: [],
        error: 'No OpenAI API key available. Enter a model manually.',
        requestKey: openaiDiscoveryKey,
      })
      return
    }
    if (
      openaiModelDiscovery.requestKey === openaiDiscoveryKey &&
      ['loading', 'loaded'].includes(openaiModelDiscovery.status)
    ) {
      return
    }

    let cancelled = false
    setOpenaiModelDiscovery({
      status: 'loading',
      models: [],
      error: null,
      requestKey: openaiDiscoveryKey,
    })

    void discoverOpenAIModels({
      apiKey: resolvedOpenAIKey,
      baseUrl: openaiBaseUrl || undefined,
      currentModel: openaiModel || undefined,
    })
      .then(models => {
        if (cancelled) {
          return
        }
        setOpenaiModelDiscovery({
          status: 'loaded',
          models,
          error: null,
          requestKey: openaiDiscoveryKey,
        })
      })
      .catch(error => {
        if (cancelled) {
          return
        }
        setOpenaiModelDiscovery({
          status: 'failed',
          models: [],
          error: discoveryErrorMessage(error),
          requestKey: openaiDiscoveryKey,
        })
      })

    return () => {
      cancelled = true
    }
  }, [
    step,
    resolvedOpenAIKey,
    openaiBaseUrl,
    openaiModel,
    openaiDiscoveryKey,
    openaiModelDiscovery.requestKey,
    openaiModelDiscovery.status,
  ])

  useEffect(() => {
    if (step !== 'geminiModel') {
      return
    }
    if (!resolvedGeminiKey) {
      if (
        geminiModelDiscovery.requestKey === geminiDiscoveryKey &&
        geminiModelDiscovery.status === 'failed'
      ) {
        return
      }
      setGeminiModelDiscovery({
        status: 'failed',
        models: [],
        error: 'No Gemini API key available. Enter a model manually.',
        requestKey: geminiDiscoveryKey,
      })
      return
    }
    if (
      geminiModelDiscovery.requestKey === geminiDiscoveryKey &&
      ['loading', 'loaded'].includes(geminiModelDiscovery.status)
    ) {
      return
    }

    let cancelled = false
    setGeminiModelDiscovery({
      status: 'loading',
      models: [],
      error: null,
      requestKey: geminiDiscoveryKey,
    })

    void discoverGeminiModels({
      apiKey: resolvedGeminiKey,
      baseUrl: geminiBaseUrl || undefined,
      currentModel: geminiModel || undefined,
    })
      .then(models => {
        if (cancelled) {
          return
        }
        setGeminiModelDiscovery({
          status: 'loaded',
          models,
          error: null,
          requestKey: geminiDiscoveryKey,
        })
      })
      .catch(error => {
        if (cancelled) {
          return
        }
        setGeminiModelDiscovery({
          status: 'failed',
          models: [],
          error: discoveryErrorMessage(error),
          requestKey: geminiDiscoveryKey,
        })
      })

    return () => {
      cancelled = true
    }
  }, [
    step,
    resolvedGeminiKey,
    geminiBaseUrl,
    geminiModel,
    geminiDiscoveryKey,
    geminiModelDiscovery.requestKey,
    geminiModelDiscovery.status,
  ])

  function goToProviderConfig(selected: ConfigurableProvider): void {
    setProvider(selected)
    setError(null)
    if (selected === 'openai') {
      setStep('openaiApiKey')
      return
    }
    if (selected === 'gemini') {
      setStep('geminiApiKey')
      return
    }
    setStep('anthropicBaseUrl')
  }

  function getPreviousStep(currentStep: WizardStep): WizardStep | null {
    switch (currentStep) {
      case 'provider':
        return null
      case 'openaiApiKey':
        return 'provider'
      case 'openaiBaseUrl':
        return 'openaiApiKey'
      case 'openaiModel':
        return 'openaiBaseUrl'
      case 'openaiModelManual':
        return 'openaiModel'
      case 'openaiMode':
        return 'openaiModel'
      case 'geminiApiKey':
        return 'provider'
      case 'geminiBaseUrl':
        return 'geminiApiKey'
      case 'geminiModel':
        return 'geminiBaseUrl'
      case 'geminiModelManual':
        return 'geminiModel'
      case 'anthropicBaseUrl':
        return 'provider'
      case 'anthropicModel':
        return 'anthropicBaseUrl'
      case 'confirm':
        if (provider === 'openai') return 'openaiMode'
        if (provider === 'gemini') return 'geminiModel'
        return 'anthropicModel'
    }
  }

  function handleCancelOrBack(): void {
    if (isValidating) {
      return
    }
    setError(null)
    const previousStep = getPreviousStep(step)
    if (previousStep) {
      setStep(previousStep)
      return
    }
    onCancel?.()
  }

  async function save(): Promise<void> {
    const result =
      provider === 'openai'
        ? persistProviderConfig({
            provider,
            apiKey: openaiApiKey || undefined,
            baseUrl: openaiBaseUrl || undefined,
            model: openaiModel || undefined,
            apiMode: openaiMode,
          })
        : provider === 'gemini'
          ? persistProviderConfig({
              provider,
              apiKey: geminiApiKey || undefined,
              baseUrl: geminiBaseUrl || undefined,
              model: geminiModel || undefined,
            })
          : persistProviderConfig({
              provider,
              baseUrl: anthropicBaseUrl || undefined,
              model: anthropicModel || undefined,
            })
    if (result.error) {
      setError(result.error.message)
      return
    }
    resetRuntimeProviderFlags()
    applyConfigEnvironmentVariables()
    setError(null)
    setIsValidating(true)
    try {
      await validateConfiguredProvider()
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : String(validationError),
      )
      setIsValidating(false)
      return
    }
    setIsValidating(false)
    onDone(provider)
  }

  if (step === 'provider') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Choose your AI provider</Text>
        <Text dimColor width={72}>
          This provider will drive the entire AI core path, including tools,
          agents, side queries, and model selection.
        </Text>
        {!runtimeProviderIsInteractive && (
          <Text color="yellow" width={72}>
            Current runtime provider: {runtimeProviderLabel}. This backend is
            configured outside the wizard via environment variables, so the
            options below only update saved Anthropic/OpenAI/Gemini settings.
          </Text>
        )}
        {process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1' && (
          <Text color="yellow" width={72}>
            Provider routing is managed by the host environment. Saved settings
            may not become active until that override is removed.
          </Text>
        )}
        <Select
          options={PROVIDER_OPTIONS.map(option => ({
            label: `${option.label} - ${option.description}`,
            value: option.value,
          }))}
          defaultValue={provider}
          defaultFocusValue={provider}
          onChange={value => goToProviderConfig(value as ConfigurableProvider)}
          onCancel={onCancel}
        />
      </Box>
    )
  }

  if (step === 'openaiApiKey') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>OpenAI-compatible API key</Text>
        <Text dimColor width={72}>
          Enter the API key for your OpenAI-compatible provider.
          {existingOpenAIKey
            ? ' Press Enter on an empty input to keep the existing key.'
            : ''}
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={openaiApiKey}
            onChange={setOpenaiApiKey}
            onSubmit={() => setStep('openaiBaseUrl')}
            placeholder={existingOpenAIKey ? 'Keep existing key' : 'sk-...'}
            mask="*"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'openaiBaseUrl') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>OpenAI-compatible base URL</Text>
        <Text dimColor width={72}>
          Optional. Leave empty for OpenAI official API, or set a compatible
          gateway base URL.
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={openaiBaseUrl}
            onChange={setOpenaiBaseUrl}
            onSubmit={() => setStep('openaiModel')}
            placeholder="https://api.openai.com/v1"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'openaiModel') {
    if (
      openaiModelDiscovery.status === 'loaded' &&
      openaiModelDiscovery.models.length > 0
    ) {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Choose a default OpenAI-compatible model</Text>
          <Text dimColor width={72}>
            The model list was loaded from your configured provider. Pick one or
            enter a custom model manually.
          </Text>
          <Select
            layout="compact-vertical"
            visibleOptionCount={8}
            defaultValue={openaiModel}
            defaultFocusValue={
              openaiModelDiscovery.models.some(model => model.id === openaiModel)
                ? openaiModel
                : openaiModelDiscovery.models[0]?.id
            }
            options={[
              ...openaiModelDiscovery.models.map(model => ({
                label: model.label,
                value: model.id,
                description: model.description,
              })),
              {
                label: 'Enter model manually',
                value: MODEL_DISCOVERY_MANUAL_VALUE,
                description: 'Type a custom model ID not shown in the fetched list',
              },
            ]}
            onChange={value => {
              if (value === MODEL_DISCOVERY_MANUAL_VALUE) {
                setStep('openaiModelManual')
                return
              }
              setOpenaiModel(String(value))
              setStep('openaiMode')
            }}
            onCancel={handleCancelOrBack}
          />
        </Box>
      )
    }

    if (suggestedOpenAIModels.length > 0) {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Choose a default OpenAI-compatible model</Text>
          <Text dimColor width={72}>
            {openaiModelDiscovery.status === 'loading'
              ? 'Checking the provider for available models in the background. You can already pick from the suggested list below or enter a model manually.'
              : 'Automatic model discovery was not available on this endpoint, so a suggested list is shown instead. You can still enter any model manually.'}
          </Text>
          {openaiModelDiscovery.status === 'loading' ? (
            <Text dimColor width={72}>Loading model list...</Text>
          ) : null}
          {openaiModelDiscovery.error ? (
            <Text color="yellow" width={72}>
              Could not load the model list automatically: {openaiModelDiscovery.error}
            </Text>
          ) : null}
          <Select
            layout="compact-vertical"
            visibleOptionCount={8}
            defaultValue={openaiModel}
            defaultFocusValue={
              suggestedOpenAIModels.some(model => model.id === openaiModel)
                ? openaiModel
                : suggestedOpenAIModels[0]?.id
            }
            options={[
              ...suggestedOpenAIModels.map(model => ({
                label: model.label,
                value: model.id,
                description: model.description,
              })),
              {
                label: 'Enter model manually',
                value: MODEL_DISCOVERY_MANUAL_VALUE,
                description: 'Type a custom model ID not shown in the suggested list',
              },
            ]}
            onChange={value => {
              if (value === MODEL_DISCOVERY_MANUAL_VALUE) {
                setStep('openaiModelManual')
                return
              }
              setOpenaiModel(String(value))
              setStep('openaiMode')
            }}
            onCancel={handleCancelOrBack}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Default OpenAI-compatible model</Text>
        <Text dimColor width={72}>
          This becomes the default model for the main REPL loop.
        </Text>
        {openaiModelDiscovery.error ? (
          <Text color="yellow" width={72}>
            Could not load the model list automatically: {openaiModelDiscovery.error}
          </Text>
        ) : null}
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={openaiModel}
            onChange={setOpenaiModel}
            onSubmit={() => setStep('openaiMode')}
            placeholder="gpt-5.4"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'openaiModelManual') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Enter a custom OpenAI-compatible model</Text>
        <Text dimColor width={72}>
          Type any model ID supported by your provider.
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={openaiModel}
            onChange={setOpenaiModel}
            onSubmit={() => setStep('openaiMode')}
            placeholder="gpt-5.4"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'openaiMode') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>OpenAI protocol mode</Text>
        <Text dimColor width={72}>
          Use Responses for OpenAI official APIs, or Chat Completions for broader
          compatibility with OpenAI-style gateways.
        </Text>
        <Select
          options={[
            {
              label: 'Responses API (recommended)',
              value: 'responses',
            },
            {
              label: 'Chat Completions',
              value: 'chat_completions',
            },
          ]}
          defaultValue={openaiMode}
          defaultFocusValue={openaiMode}
          onChange={value => {
            setOpenaiMode(value as 'responses' | 'chat_completions')
            setStep('confirm')
          }}
          onCancel={handleCancelOrBack}
        />
      </Box>
    )
  }

  if (step === 'geminiApiKey') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Gemini API key</Text>
        <Text dimColor width={72}>
          Enter your Gemini API key.
          {existingGeminiKey
            ? ' Press Enter on an empty input to keep the existing key.'
            : ''}
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={geminiApiKey}
            onChange={setGeminiApiKey}
            onSubmit={() => setStep('geminiBaseUrl')}
            placeholder={existingGeminiKey ? 'Keep existing key' : 'AIza...'}
            mask="*"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'geminiBaseUrl') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Gemini base URL</Text>
        <Text dimColor width={72}>
          Optional. Leave empty for the default Google Gemini endpoint, or set a
          custom Gemini-compatible gateway base URL.
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={geminiBaseUrl}
            onChange={setGeminiBaseUrl}
            onSubmit={() => setStep('geminiModel')}
            placeholder="https://generativelanguage.googleapis.com"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'geminiModel') {
    if (
      geminiModelDiscovery.status === 'loaded' &&
      geminiModelDiscovery.models.length > 0
    ) {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Choose a default Gemini model</Text>
          <Text dimColor width={72}>
            The model list was loaded from your configured provider. Pick one or
            enter a custom model manually.
          </Text>
          <Select
            layout="compact-vertical"
            visibleOptionCount={8}
            defaultValue={geminiModel}
            defaultFocusValue={
              geminiModelDiscovery.models.some(model => model.id === geminiModel)
                ? geminiModel
                : geminiModelDiscovery.models[0]?.id
            }
            options={[
              ...geminiModelDiscovery.models.map(model => ({
                label: model.label,
                value: model.id,
                description: model.description,
              })),
              {
                label: 'Enter model manually',
                value: MODEL_DISCOVERY_MANUAL_VALUE,
                description: 'Type a custom model ID not shown in the fetched list',
              },
            ]}
            onChange={value => {
              if (value === MODEL_DISCOVERY_MANUAL_VALUE) {
                setStep('geminiModelManual')
                return
              }
              setGeminiModel(String(value))
              setStep('confirm')
            }}
            onCancel={handleCancelOrBack}
          />
        </Box>
      )
    }

    if (suggestedGeminiModels.length > 0) {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Choose a default Gemini model</Text>
          <Text dimColor width={72}>
            {geminiModelDiscovery.status === 'loading'
              ? 'Checking the provider for available Gemini models in the background. You can already pick from the suggested list below or enter a model manually.'
              : 'Gemini model discovery was not available on this endpoint, so a suggested list is shown instead. You can still enter any model manually.'}
          </Text>
          {geminiModelDiscovery.status === 'loading' ? (
            <Text dimColor width={72}>Loading model list...</Text>
          ) : null}
          {geminiModelDiscovery.error ? (
            <Text color="yellow" width={72}>
              Could not load the model list automatically: {geminiModelDiscovery.error}
            </Text>
          ) : null}
          <Select
            layout="compact-vertical"
            visibleOptionCount={8}
            defaultValue={geminiModel}
            defaultFocusValue={
              suggestedGeminiModels.some(model => model.id === geminiModel)
                ? geminiModel
                : suggestedGeminiModels[0]?.id
            }
            options={[
              ...suggestedGeminiModels.map(model => ({
                label: model.label,
                value: model.id,
                description: model.description,
              })),
              {
                label: 'Enter model manually',
                value: MODEL_DISCOVERY_MANUAL_VALUE,
                description: 'Type a custom model ID not shown in the suggested list',
              },
            ]}
            onChange={value => {
              if (value === MODEL_DISCOVERY_MANUAL_VALUE) {
                setStep('geminiModelManual')
                return
              }
              setGeminiModel(String(value))
              setStep('confirm')
            }}
            onCancel={handleCancelOrBack}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Default Gemini model</Text>
        <Text dimColor width={72}>
          Gemini requests will use this as the default model.
        </Text>
        {geminiModelDiscovery.error ? (
          <Text color="yellow" width={72}>
            Could not load the model list automatically: {geminiModelDiscovery.error}
          </Text>
        ) : null}
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={geminiModel}
            onChange={setGeminiModel}
            onSubmit={() => setStep('confirm')}
            placeholder="gemini-2.5-flash"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'geminiModelManual') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Enter a custom Gemini model</Text>
        <Text dimColor width={72}>
          Type any model ID supported by your provider.
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={geminiModel}
            onChange={setGeminiModel}
            onSubmit={() => setStep('confirm')}
            placeholder="gemini-2.5-flash"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'anthropicBaseUrl') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Anthropic-compatible base URL</Text>
        <Text dimColor width={72}>
          Optional. Leave empty for Anthropic first-party, or set a compatible
          endpoint.
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={anthropicBaseUrl}
            onChange={setAnthropicBaseUrl}
            onSubmit={() => setStep('anthropicModel')}
            placeholder="https://api.anthropic.com"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  if (step === 'anthropicModel') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Default Anthropic-compatible model</Text>
        <Text dimColor width={72}>
          This only affects Anthropic-compatible startup paths.
        </Text>
        <Box borderStyle="round" paddingLeft={1}>
          <TextInput
            value={anthropicModel}
            onChange={setAnthropicModel}
            onSubmit={() => setStep('confirm')}
            placeholder="sonnet"
            focus
            showCursor
            columns={72}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onExit={handleCancelOrBack}
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Save provider configuration</Text>
      <Text dimColor width={72}>
        Provider: {PROVIDER_OPTIONS.find(option => option.value === provider)?.label}
      </Text>
      {provider === 'openai' && (
        <Text dimColor width={72}>
          Model: {openaiModel} | Mode:{' '}
          {openaiMode === 'responses' ? 'Responses API' : 'Chat Completions'}
        </Text>
      )}
      {provider === 'gemini' && (
        <Text dimColor width={72}>
          Model: {geminiModel}
          {geminiBaseUrl ? ` | Base URL: ${geminiBaseUrl}` : ''}
        </Text>
      )}
      {provider === 'anthropic' && (
        <Text dimColor width={72}>Model: {anthropicModel || 'sonnet'}</Text>
      )}
      {provider === 'anthropic' && (
        <Text dimColor width={72}>
          Anthropic-compatible settings are saved directly. A live validation
          ping is only performed for OpenAI-compatible and Gemini providers.
        </Text>
      )}
      {error ? <Text color="red">{error}</Text> : null}
      {isValidating ? <Text dimColor>Validating provider connection...</Text> : null}
      <Select
        isDisabled={isValidating}
        options={[
          {
            label: 'Save and continue',
            value: 'save',
          },
          {
            label: 'Start over',
            value: 'restart',
          },
        ]}
        onChange={value => {
          if (isValidating) {
            return
          }
          if (value === 'restart') {
            setStep('provider')
            return
          }
          void save()
        }}
        onCancel={handleCancelOrBack}
      />
    </Box>
  )
}

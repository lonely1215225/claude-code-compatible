import { c as _c } from "react/compiler-runtime";
import * as React from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { ProviderSetupStep } from '../../components/ProviderSetupStep.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  PROVIDER_OPTIONS,
  type ConfigurableProvider,
} from '../../utils/providerConfig.js'
import { getDefaultMainLoopModel } from '../../utils/model/model.js'
import { getCurrentProviderLabel } from '../../utils/model/providers.js'
import { refreshModelStringsForCurrentProvider } from '../../utils/model/modelStrings.js'

type Props = {
  onDone: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
}

function ProviderCommand(t0: Props) {
  const $ = _c(6)
  const { onDone } = t0
  const setAppState = useSetAppState()

  let t1
  if ($[0] !== onDone || $[1] !== setAppState) {
    t1 = (provider: ConfigurableProvider) => {
      refreshModelStringsForCurrentProvider()
      const nextDefaultModel = getDefaultMainLoopModel()
      setAppState(prev => ({
        ...prev,
        mainLoopModel: null,
        mainLoopModelForSession: nextDefaultModel,
      }))
      const selectedLabel =
        PROVIDER_OPTIONS.find(option => option.value === provider)?.label ?? provider
      const runtimeLabel = getCurrentProviderLabel()
      onDone(
        selectedLabel === runtimeLabel
          ? `Provider set to ${runtimeLabel}. Active model reset to this provider's default.`
          : `Saved ${selectedLabel} provider settings. Runtime provider is still ${runtimeLabel}, so the active model was reset to that provider's default.`,
        { display: 'system' },
      )
    }
    $[0] = onDone
    $[1] = setAppState
    $[2] = t1
  } else {
    t1 = $[2]
  }

  let t2
  if ($[3] !== onDone || $[4] !== t1) {
    t2 = (
      <Pane color="permission">
        <ProviderSetupStep
          onDone={t1}
          onCancel={() =>
            onDone('Provider setup dismissed.', {
              display: 'system',
            })
          }
        />
      </Pane>
    )
    $[3] = onDone
    $[4] = t1
    $[5] = t2
  } else {
    t2 = $[5]
  }

  return t2
}

export const call: LocalJSXCommandCall = async onDone => {
  return <ProviderCommand onDone={onDone} />
}

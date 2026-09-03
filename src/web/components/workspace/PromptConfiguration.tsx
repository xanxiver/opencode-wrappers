import type { Accessor } from "solid-js"
import { Bot, SlidersHorizontal, SquareTerminal } from "lucide-solid"
import { Button } from "../ui/button"
import type { AgentOption, ModelOption } from "../../state/app-view-model"

type Styles = Readonly<Record<string, string>>

export interface PromptConfigurationProps {
  readonly styles: Styles
  readonly selectedModel: Accessor<ModelOption | undefined>
  readonly unavailableModel: Accessor<boolean>
  readonly variantKey: Accessor<string>
  readonly agents: Accessor<readonly AgentOption[]>
  readonly agentKey: Accessor<string>
  readonly selectedAgent: Accessor<AgentOption | undefined>
  readonly loadingModels: Accessor<boolean>
  readonly switchingModel: Accessor<boolean>
  readonly switchingVariant: Accessor<boolean>
  readonly switchingAgent: Accessor<boolean>
  readonly openModelPicker: () => void
  readonly openAgentPicker: () => void
}

export function PromptConfiguration(props: PromptConfigurationProps) {
  const styles = props.styles
  const modelLabel = (): string => {
    if (props.loadingModels() || props.switchingModel()) return "Loading…"
    if (props.unavailableModel()) return "Unavailable model"
    return props.selectedModel()?.name ?? "Choose model"
  }
  const agentLabel = () => props.selectedAgent()?.name ?? (props.agentKey() || "Default")
  return (
    <div class={styles.composerControls} aria-label="Prompt controls">
      <Button class={styles.composerControl} variant="ghost" size="sm" aria-label="Choose model" disabled={props.loadingModels() || props.switchingModel() || props.switchingVariant()} onClick={props.openModelPicker}>
        <Bot size={15} aria-hidden="true" />
        <span class={styles.composerControlCopy}><span class={styles.composerControlLabel}>Model</span><span class={styles.composerControlValue}>{modelLabel()}</span></span>
      </Button>
      <Button class={styles.composerControl} variant="ghost" size="sm" aria-label={`Model variant: ${props.variantKey() || "default"}`} aria-keyshortcuts="Control+j Meta+j" disabled={(props.selectedModel()?.variants?.length ?? 0) === 0 || props.switchingModel() || props.switchingVariant()} onClick={props.openModelPicker}>
        <SlidersHorizontal size={15} aria-hidden="true" />
        <span class={styles.composerControlCopy}><span class={styles.composerControlLabel}>Variant</span><span class={styles.composerControlValue}>{props.variantKey() || "Default"}</span></span>
      </Button>
      <Button class={styles.composerControl} variant="ghost" size="sm" aria-label="Choose agent" aria-keyshortcuts="Control+Shift+a Meta+Shift+a" disabled={props.agents().length === 0 || props.switchingAgent()} onClick={props.openAgentPicker}>
        <SquareTerminal size={15} aria-hidden="true" />
        <span class={styles.composerControlCopy}><span class={styles.composerControlLabel}>Agent</span><span class={styles.composerControlValue}>{agentLabel()}</span></span>
      </Button>
    </div>
  )
}

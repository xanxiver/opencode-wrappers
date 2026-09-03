import type { Accessor } from "solid-js"
import { For, Show } from "solid-js"
import { Paperclip, Send, Square, X } from "lucide-solid"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import type { AgentOption, ModelOption, PendingAttachment } from "../../state/app-view-model"
import { PromptConfiguration } from "./PromptConfiguration"

type Styles = Readonly<Record<string, string>>

export interface ComposerProps {
  readonly styles: Styles
  readonly selectedID: Accessor<string | undefined>
  readonly attachments: Accessor<readonly PendingAttachment[]>
  readonly directory: Accessor<string>
  readonly busy: Accessor<boolean>
  readonly text: Accessor<string>
  readonly isLight: Accessor<boolean>
  readonly chatWidthClass: Accessor<string>
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
  readonly interrupting: Accessor<boolean>
  readonly openModelPicker: () => void
  readonly openAgentPicker: () => void
  readonly chooseAttachments: (event: Event) => void
  readonly updateText: (event: InputEvent) => void
  readonly submit: (event: SubmitEvent) => void
  readonly submitFromKeyboard: (event: KeyboardEvent) => void
  readonly interrupt: () => void
  readonly removeAttachment: (id: string) => void
}

export function Composer(props: ComposerProps) {
  const styles = props.styles
  const placeholder = (): string => {
    if (props.directory().length === 0) return "Choose a project to enable chat"
    if (props.busy()) return "Add another prompt to the queue..."
    return "Message OpenCode..."
  }
  return (
    <div class={`${styles.composerWrap} ${props.chatWidthClass()}`}>
      <div class={styles.composerStack}>
        <Show when={props.selectedID() !== undefined}>
          <div class={styles.composerControls} aria-label="Prompt controls">
            <PromptConfiguration styles={styles} selectedModel={props.selectedModel} unavailableModel={props.unavailableModel} variantKey={props.variantKey} agents={props.agents} agentKey={props.agentKey} selectedAgent={props.selectedAgent} loadingModels={props.loadingModels} switchingModel={props.switchingModel} switchingVariant={props.switchingVariant} switchingAgent={props.switchingAgent} openModelPicker={props.openModelPicker} openAgentPicker={props.openAgentPicker} />
          </div>
        </Show>
        <Show when={props.attachments().length > 0}><div class={styles.chipList}><For each={props.attachments()}>{(attachment) => <div class={styles.chip}><span class={styles.chipName}>{attachment.name}</span><button class={styles.chipDelete} aria-label={`Remove ${attachment.name}`} onClick={() => props.removeAttachment(attachment.id)}><X size={13} /></button></div>}</For></div></Show>
        <form class={`${styles.composer} ${props.isLight() ? styles.lightComposer : ""}`} onSubmit={props.submit}>
          <Show when={props.directory().length > 0}><label class={styles.attachmentButton} title="Attach files">
            <input class={styles.attachmentInput} type="file" multiple onChange={props.chooseAttachments} aria-label="Attach files" />
            <Paperclip size={18} />
          </label></Show>
          <Textarea class={`${styles.input} ${props.isLight() ? styles.lightInput : ""}`} rows="1" disabled={props.directory().length === 0} aria-label="Message" aria-keyshortcuts="Enter Alt+Q" placeholder={placeholder()} value={props.text()} onInput={props.updateText} onKeyDown={props.submitFromKeyboard} />
          <Show when={props.busy()} fallback={<Button class={styles.sendButton} type="submit" disabled={props.directory().length === 0 || props.selectedID() === undefined || (props.text().trim().length === 0 && props.attachments().length === 0)}><Send size={16} />Send</Button>}>
            <Button class={styles.stopButton} type="button" aria-label="Stop processing prompt" loading={props.interrupting()} loadingText="Stopping…" onClick={props.interrupt}><Square size={15} />Stop</Button>
          </Show>
        </form>
      </div>
       <div class={`${styles.hint} ${props.isLight() ? styles.lightHint : ""}`}><span>Enter sends · Alt+Q opens queue · Shift+Enter adds a line</span><span class={styles.hintSecondary}>⌘/Ctrl J variant · ⌘/Ctrl ⇧ A agent</span></div>
    </div>
  )
}

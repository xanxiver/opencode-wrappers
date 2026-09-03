import { For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Trash2, X } from "lucide-solid"
import { Button } from "../ui/button"
import { Dialog } from "../ui/dialog"
import type { QueuedPrompt } from "../../state/app-view-model"

type Styles = Readonly<Record<string, string>>

export interface QueueDialogProps {
  readonly styles: Styles
  readonly open: boolean
  readonly prompts: readonly QueuedPrompt[]
  readonly close: () => void
  readonly remove: (id: string) => void
}

export function QueueDialog(props: QueueDialogProps) {
  return (
    <Dialog.Root open={props.open} onOpenChange={(details) => { if (!details.open) props.close() }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content class={props.styles.queueDialogContent}>
            <Dialog.Header>
              <Dialog.Title>Prompt queue</Dialog.Title>
              <Dialog.Description>Queued prompts will run in order.</Dialog.Description>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} variant="ghost" size="sm" class={props.styles.dialogClose} aria-label="Close prompt queue">
                <X size={16} />
              </Button>} />
            <Dialog.Body>
              <Show when={props.prompts.length > 0} fallback={<div class={props.styles.queueEmpty}>No prompts are queued.</div>}>
                <div class={props.styles.queueList} aria-label="Queued prompts">
                  <For each={props.prompts}>{(prompt, index) => (
                    <div class={props.styles.queueItem}>
                      <div class={props.styles.queueItemCopy}>
                        <span class={props.styles.queueItemIndex}>Queued {index() + 1}</span>
                        <span class={props.styles.queueItemText}>{prompt.text || `${prompt.attachments.length} file${prompt.attachments.length === 1 ? "" : "s"}`}</span>
                        <Show when={prompt.attachments.length > 0}>
                          <span class={props.styles.queueItemDetail}>{prompt.attachments.map((attachment) => attachment.name).join(", ")}</span>
                        </Show>
                      </div>
                      <Button variant="ghost" size="sm" class={props.styles.queueRemove} aria-label={`Remove queued prompt ${index() + 1}`} onClick={() => props.remove(prompt.id)}>
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  )}</For>
                </div>
              </Show>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}

import type { Accessor } from "solid-js"
import { For, Show } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { Command, Copy, FolderGit2, Plus, Quote, RotateCcw, Undo2 } from "lucide-solid"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardBody } from "../ui/card"
import { ScrollArea } from "../ui/scroll-area"
import { MessageContent } from "../message-content"
import type { AppState, ChatMessage } from "../../state/app-view-model"
import type { AppEffectRunner } from "../../state/api-client"

type Styles = Readonly<Record<string, string>>

export interface ConversationPaneProps {
  readonly styles: Styles
  readonly state: Accessor<AppState>
  readonly messages: Accessor<readonly ChatMessage[]>
  readonly directory: Accessor<string>
  readonly busy: Accessor<boolean>
  readonly isLight: Accessor<boolean>
  readonly copiedMessage: Accessor<string | undefined>
  readonly stickToBottom: Accessor<boolean>
  readonly latestAvailable: Accessor<boolean>
  readonly chatWidthClass: Accessor<string>
  readonly expandChatDetails: Accessor<boolean>
  readonly effectRunner: AppEffectRunner
  readonly copyMessage: (text: string) => void
  readonly quoteMessage: (text: string) => void
  readonly retryMessage: (text: string) => void
  readonly requestRevert: (message: ChatMessage) => void
  readonly createSession: () => void
  readonly openProjectPicker: () => void
  readonly jumpToLatest: () => void
  readonly onScroll: () => void
  readonly setViewport: (element: HTMLElement) => void
}

export function ConversationPane(props: ConversationPaneProps) {
  const styles = props.styles
  const messageClass = (message: ChatMessage): string => {
    if (message.role === "user") return props.isLight() ? styles.lightUser : styles.user
    return props.isLight() ? styles.lightAssistant : styles.assistant
  }
  const roleLabel = (message: ChatMessage): string => {
    if (message.role === "user") return "You"
    if (message.role === "assistant") return "Assistant"
    return "System"
  }
  let viewportElement: HTMLElement | undefined
  const rowVirtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
    get count() { return props.messages().length },
    getScrollElement: () => viewportElement ?? null,
    estimateSize: () => 168,
    overscan: 6,
    gap: 12,
    getItemKey: (index) => props.messages()[index]?.id ?? `pending-${index}-${props.messages()[index]?.text ?? ""}`,
  })
  const setViewport = (element: HTMLElement): void => {
    viewportElement = element
    props.setViewport(element)
  }
  return (
    <ScrollArea.Root class={`${styles.conversation} ${props.chatWidthClass()}`} aria-label="Conversation" role="log">
      <ScrollArea.Viewport ref={setViewport} onScroll={props.onScroll}>
        <ScrollArea.Content class={`${styles.chatContentRail} ${props.chatWidthClass()}`}>
          <Show when={props.state().hasOlderMessages || props.state().loading.loadingOlderMessages}>
            <div class={styles.olderMessages} aria-live="polite">{props.state().loading.loadingOlderMessages ? "Loading older messages…" : "Scroll up to load older messages"}</div>
          </Show>
          <Show when={props.messages().length > 0} fallback={
            <div class={styles.empty}>
              <div class={styles.emptyInner}>
                <div class={styles.emptyIcon}>{props.directory().length === 0 ? <FolderGit2 size={20} /> : <Command size={20} />}</div>
                <Show when={props.directory().length === 0} fallback={
                  <>
                    <div class={styles.emptyTitle}>Choose a session to begin</div>
                    <div class={styles.emptyText}>Pick a session from the sidebar, or create a new one to get started.</div>
                    <div class={styles.emptyActions}><Button class={styles.emptyAction} onClick={props.createSession} disabled={props.state().loading.creatingSession}><Plus size={16} />{props.state().loading.creatingSession ? "Creating…" : "New session"}</Button></div>
                  </>
                }>
                  <div class={styles.emptyTitle}>Choose a project first</div>
                  <div class={styles.emptyText}>Select a workspace before you create a session or send a message. Your project controls which files OpenCode can access.</div>
                  <div class={styles.projectGate}>
                    <div class={styles.projectGateTitle}><FolderGit2 size={17} /> Workspace required</div>
                    <div class={styles.projectGateDetail}>Choose a project from the sidebar or open the project picker below.</div>
                    <div class={styles.emptyActions}><Button class={styles.emptyAction} onClick={props.openProjectPicker}><FolderGit2 size={16} /> Choose project</Button></div>
                  </div>
                </Show>
              </div>
            </div>
          }>
            <div class={styles.virtualMessageList} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
              <For each={rowVirtualizer.getVirtualItems()}>{(virtualRow) => {
                const message = () => props.messages()[virtualRow.index]
                const continuation = () => virtualRow.index > 0 && props.messages()[virtualRow.index - 1]?.role === message()?.role
                return <div
                  ref={(element) => {
                    element.dataset.index = String(virtualRow.index)
                    rowVirtualizer.measureElement(element)
                  }}
                  class={`${styles.virtualMessageRow} ${styles.messageRow} ${message()?.role === "user" ? styles.userRow : styles.assistantRow} ${continuation() ? styles.messageContinuation : ""}`}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <Show when={message()}>{(item) => <>
                   <Card class={`${styles.message} message-card group ${messageClass(item())}`}>
                     <div class={`${styles.messageMeta} ${continuation() ? styles.messageHiddenMeta : ""}`}><Badge variant="subtle" size="sm">{roleLabel(item())}</Badge></div>
                    <CardBody class={styles.messageBody}>
                      <Show when={item().role === "assistant" && (item().reasoning !== undefined || (item().tools?.length ?? 0) > 0)}>
                        <details class={styles.historyPanel} open={props.expandChatDetails()}>
                          <summary class={styles.historySummary}>Execution details</summary>
                          <Show when={item().reasoning !== undefined}><details class={styles.reasoningPanel} open={props.expandChatDetails()}><summary class={styles.reasoningSummary}>Reasoning</summary><MessageContent text={item().reasoning ?? ""} directory={props.directory()} effectRunner={props.effectRunner} /></details></Show>
                          <Show when={(item().tools?.length ?? 0) > 0}><div class={styles.historyList} aria-label="Tools used"><For each={item().tools}>{(tool) => <div>{tool}</div>}</For></div></Show>
                        </details>
                      </Show>
                      <MessageContent text={item().text} directory={props.directory()} effectRunner={props.effectRunner} />
                    </CardBody>
                    <div class={`${styles.messageActions} message-actions`} aria-label="Message actions">
                      <Button class={`${styles.messageAction} message-action`} variant="ghost" size="sm" aria-label="Copy message" onClick={() => props.copyMessage(item().text)}><Copy size={13} /><span class="message-action-label">{props.copiedMessage() === item().text ? "Copied" : "Copy"}</span></Button>
                      <span class={styles.srOnly} aria-live="polite">{props.copiedMessage() === item().text ? "Message copied" : ""}</span>
                      <Button class={`${styles.messageAction} message-action`} variant="ghost" size="sm" aria-label="Quote message" onClick={() => props.quoteMessage(item().text)}><Quote size={13} /><span class="message-action-label">Quote</span></Button>
                      <Show when={item().role === "user" && item().retryable}><Button class={`${styles.messageAction} message-action`} variant="ghost" size="sm" aria-label="Retry failed message" onClick={() => props.retryMessage(item().text)}><RotateCcw size={13} /><span class="message-action-label">Retry</span></Button></Show>
                      <Show when={item().role === "user" && item().id !== undefined}><Button class={`${styles.messageAction} message-action`} variant="ghost" size="sm" aria-label="Revert to this message" disabled={props.busy()} onClick={() => props.requestRevert(item())}><Undo2 size={13} /><span class="message-action-label">Revert</span></Button></Show>
                    </div>
                  </Card>
                  </>}</Show>
                </div>
              }}</For>
            </div>
          </Show>
          <Show when={props.busy() || props.state().streamedText.length > 0 || props.state().reasoning.length > 0 || props.state().activityHistory.length > 0}>
            <div class={styles.streamCard} aria-live="off">
              <div class={styles.streamHeader} role="status" aria-live="polite"><span class={styles.streamPulse} aria-hidden="true" />{props.state().activity ?? (props.state().reasoning.length > 0 ? "Thinking" : "Writing response")}<Badge variant="subtle" size="sm">Live</Badge></div>
              <Show when={props.state().reasoning.length > 0}><details class={styles.reasoningPanel} open={props.expandChatDetails()}><summary class={styles.reasoningSummary}>Reasoning</summary><MessageContent text={props.state().reasoning} streaming effectRunner={props.effectRunner} /></details></Show>
              <Show when={props.state().activityHistory.length > 0}><details class={styles.historyPanel} open={props.expandChatDetails()}><summary class={styles.historySummary}>Activity</summary><div class={styles.historyList} aria-label="Current activity history"><For each={props.state().activityHistory}>{(item) => <div>{item}</div>}</For></div></details></Show>
              <Show when={props.state().streamedText.length > 0} fallback={<div class={styles.executionState}><div class={styles.executionCopy}>{props.state().reasoning.length > 0 ? "Preparing the response while reasoning continues." : "OpenCode is processing your request. Live output will appear here."}</div><div class={styles.executionTrack} aria-hidden="true"><span class={styles.executionLine} /><span class={`${styles.executionLine} ${styles.executionLineShort}`} /></div></div>}>
                <div class={styles.streamBody}><MessageContent text={props.state().streamedText} streaming effectRunner={props.effectRunner} /></div>
              </Show>
            </div>
          </Show>
         </ScrollArea.Content>
       </ScrollArea.Viewport>
       <ScrollArea.Scrollbar orientation="vertical"><ScrollArea.Thumb /></ScrollArea.Scrollbar>
       <Show when={props.latestAvailable()}><Button class={styles.latestButton} size="sm" variant="outline" onClick={props.jumpToLatest}>Jump to latest</Button></Show>
    </ScrollArea.Root>
  )
}

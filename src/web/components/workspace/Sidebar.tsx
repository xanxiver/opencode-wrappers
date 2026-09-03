import type { Accessor, JSX } from "solid-js"
import { For, Show } from "solid-js"
import { FolderGit2, MessageSquare, PanelLeftClose, Plus, Settings2, SquareTerminal, Star } from "lucide-solid"
import { Button } from "../ui/button"
import { Drawer } from "../ui/drawer"
import type { ProjectOption, Session } from "../../state/app-view-model"

type Styles = Readonly<Record<string, string>>

export interface SidebarProps {
  readonly styles: Styles
  readonly state: Accessor<{ readonly loading: { readonly projects: boolean; readonly creatingSession: boolean } }>
  readonly isLight: Accessor<boolean>
  readonly isMobile: Accessor<boolean>
  readonly sidebarOpen: Accessor<boolean>
  readonly directory: Accessor<string>
  readonly projects: Accessor<readonly ProjectOption[]>
  readonly visibleSessions: Accessor<readonly Session[]>
  readonly pinnedSessions: Accessor<readonly Session[]>
  readonly recentSessions: Accessor<readonly Session[]>
  readonly pinnedSessionsOpen: Accessor<boolean>
  readonly recentSessionsOpen: Accessor<boolean>
  readonly sessionRow: (session: Session) => JSX.Element
  readonly createSession: () => void
  readonly projectLabel: (name: string, directory: string) => string
  readonly openProjectPicker: () => void
  readonly openSettings: () => void
  readonly setSidebar: (open: boolean) => void
  readonly togglePinned: () => void
  readonly toggleRecent: () => void
  readonly openSessionBrowser: () => void
}

export function Sidebar(props: SidebarProps) {
  const styles = props.styles
  return (
    <>
      <div class={styles.sidebarHeader}>
        <div class={`${styles.brand} ${props.isLight() ? styles.lightBrand : ""}`}><span class={styles.brandIcon}><SquareTerminal size={18} /></span><span class={styles.sidebarText}>Kissa</span></div>
        <div class={styles.headerActions}>
          <Button class={styles.controlButton} variant="ghost" size="sm" aria-label="Open settings" title="Open settings" onClick={props.openSettings}><Settings2 size={16} /></Button>
          <Show when={props.isMobile()} fallback={<Button class={styles.sidebarCollapse} variant="ghost" size="sm" aria-label="Collapse sidebar" aria-controls="session-sidebar" aria-expanded={props.sidebarOpen()} onClick={() => props.setSidebar(false)}><PanelLeftClose size={18} /></Button>}>
            <Drawer.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} class={styles.drawerClose} variant="ghost" size="sm" aria-label="Close sidebar"><PanelLeftClose size={18} /></Button>} />
          </Show>
        </div>
      </div>
      <div class={styles.sidebarDetails}>
        <Button class={`${styles.newSession} ${props.isLight() ? styles.lightNewSession : ""}`} variant="outline" size="sm" disabled={props.directory().length === 0 || props.state().loading.creatingSession} onClick={props.createSession}><Plus size={16} /><span class={styles.sidebarText}>{props.state().loading.creatingSession ? "Creating…" : "New session"}</span></Button>
        <div class={`${styles.workspace} ${props.isLight() ? styles.lightWorkspace : ""}`}>
          <div class={styles.label}>Workspace</div>
           <div class={styles.selectRow}>
             <FolderGit2 size={16} class={styles.selectIcon} />
             <Button class={`${styles.pickerTrigger} ${props.isLight() ? styles.lightSelect : ""}`} variant="ghost" size="sm" aria-label="Project" disabled={props.state().loading.projects} onClick={props.openProjectPicker}>
               {props.state().loading.projects ? <span class="loading-line" aria-label="Loading projects" /> : (() => { const project = props.projects().find((item) => item.directory === props.directory()); return project === undefined ? "Choose project" : props.projectLabel(project.name, project.directory) })()}
             </Button>
           </div>
        </div>
        <div class={styles.sessions}>
          <div class={styles.sessionsHeader}><div class={styles.label}>Sessions</div><span class={styles.count}>{props.visibleSessions().length} total</span></div>
          <Show when={props.pinnedSessions().length > 0}><section class={styles.sessionGroup}><Button class={styles.sessionGroupToggle} variant="ghost" size="sm" aria-label={`${props.pinnedSessionsOpen() ? "Collapse" : "Expand"} pinned sessions`} onClick={props.togglePinned}><Star size={15} />Pinned<span class={styles.count}>{props.pinnedSessions().length}</span></Button><Show when={props.pinnedSessionsOpen()}><div><For each={props.pinnedSessions()}>{props.sessionRow}</For></div></Show></section></Show>
          <Show when={props.recentSessions().length > 0}><section class={styles.sessionGroup}><Button class={styles.sessionGroupToggle} variant="ghost" size="sm" aria-label={`${props.recentSessionsOpen() ? "Collapse" : "Expand"} recent sessions`} onClick={props.toggleRecent}><MessageSquare size={15} />Recent<span class={styles.count}>{props.recentSessions().length}</span></Button><Show when={props.recentSessionsOpen()}><div><For each={props.recentSessions()}>{props.sessionRow}</For></div></Show></section></Show>
          <Show when={props.visibleSessions().length > 5}><Button class={styles.sessionBrowseButton} variant="outline" size="sm" onClick={props.openSessionBrowser}><span>View all sessions</span><span class={styles.count}>{props.visibleSessions().length}</span></Button></Show>
        </div>
      </div>
    </>
  )
}

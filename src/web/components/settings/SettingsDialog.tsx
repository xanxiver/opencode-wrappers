import { For, createEffect, createSignal, Show } from "solid-js"
import { Activity, Bot, Check, Palette, RefreshCw, SlidersHorizontal, X } from "lucide-solid"
import { ThemePicker } from "../theme-picker"
import { Button } from "../ui/button"
import type { ObservabilitySnapshot, ThemeFamily } from "../../state/app-view-model"

type Styles = Readonly<Record<string, string>>
type SettingsSection = "appearance" | "workspace" | "agents" | "usage"

const chatWidthOptions = [
  { value: "full", label: "Full", detail: "Use the available width.", preview: "100%" },
  { value: "wide", label: "Wide", detail: "Give long replies more room.", preview: "82%" },
  { value: "normal", label: "Normal", detail: "A balanced reading width.", preview: "64%" },
  { value: "narrow", label: "Narrow", detail: "Keep reading close and focused.", preview: "45%" },
] as const

export interface SettingsDialogProps {
  readonly styles: Styles
  readonly light: boolean
  readonly family: ThemeFamily
  readonly chatWidth: string
  readonly hideSubagents: boolean
  readonly sidebarOpen: boolean
  readonly expandChatDetails: boolean
  readonly showAllSessions: boolean
  readonly mediaDirectories: string
  readonly observability?: ObservabilitySnapshot
  readonly observabilityLoading: boolean
  readonly refreshObservability: () => void
  readonly onThemePreview: (theme: "light" | "dark", family: ThemeFamily) => void
  readonly saveSettings: (settings: { readonly theme: "light" | "dark"; readonly themeFamily: ThemeFamily; readonly chatWidth: string; readonly hideSubagents: boolean; readonly sidebarOpen: boolean; readonly expandChatDetails: boolean; readonly showAllSessions: boolean; readonly mediaDirectories: string }) => void
  readonly closeSettings: () => void
  readonly onDirtyChange: (dirty: boolean) => void
}

export function SettingsDialog(props: SettingsDialogProps) {
  const styles = props.styles
  const [section, setSection] = createSignal<SettingsSection>("appearance")
  const [draftTheme, setDraftTheme] = createSignal<"light" | "dark">(props.light ? "light" : "dark")
  const [draftFamily, setDraftFamily] = createSignal<ThemeFamily>(props.family)
  const [draftChatWidth, setDraftChatWidth] = createSignal(props.chatWidth)
  const [draftHideSubagents, setDraftHideSubagents] = createSignal(props.hideSubagents)
  const [draftSidebarOpen, setDraftSidebarOpen] = createSignal(props.sidebarOpen)
  const [draftExpandChatDetails, setDraftExpandChatDetails] = createSignal(props.expandChatDetails)
  const [draftShowAllSessions, setDraftShowAllSessions] = createSignal(props.showAllSessions)
  const [draftMediaDirectories, setDraftMediaDirectories] = createSignal(props.mediaDirectories)
  const [mediaDirectoryDraft, setMediaDirectoryDraft] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const mediaDirectoryValues = () => draftMediaDirectories().split(",").map((value) => value.trim()).filter((value) => value.length > 0)
  const dirty = () => !saved() && (draftTheme() !== (props.light ? "light" : "dark") || draftFamily() !== props.family || draftChatWidth() !== props.chatWidth || draftHideSubagents() !== props.hideSubagents || draftSidebarOpen() !== props.sidebarOpen || draftExpandChatDetails() !== props.expandChatDetails || draftShowAllSessions() !== props.showAllSessions || draftMediaDirectories() !== props.mediaDirectories)
  createEffect(() => props.onDirtyChange(dirty()))
  const addMediaDirectory = (directory: string) => {
    if (directory.length === 0 || mediaDirectoryValues().includes(directory)) return
    setDraftMediaDirectories([...mediaDirectoryValues(), directory].join(","))
  }
  const addTypedMediaDirectory = () => {
    const directory = mediaDirectoryDraft().trim()
    if (directory.length === 0 || mediaDirectoryValues().includes(directory)) return
    addMediaDirectory(directory)
    setMediaDirectoryDraft("")
  }
  const removeMediaDirectory = (directory: string) => setDraftMediaDirectories(mediaDirectoryValues().filter((value) => value !== directory).join(","))
  const saveSettings = () => { setSaved(true); props.saveSettings({ theme: draftTheme(), themeFamily: draftFamily(), chatWidth: draftChatWidth(), hideSubagents: draftHideSubagents(), sidebarOpen: draftSidebarOpen(), expandChatDetails: draftExpandChatDetails(), showAllSessions: draftShowAllSessions(), mediaDirectories: draftMediaDirectories() }) }
  const formatNumber = (value: number) => new Intl.NumberFormat().format(value)
  const formatCompactNumber = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const formatCost = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
  const formatBytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`
  const formatTime = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value)
  const formatDay = (value: number) => new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(value)
  const periodTokens = (period: ObservabilitySnapshot["today"]) => period.input + period.output + period.reasoning

  return (
    <div class={styles.settingsLayout}>
      <nav class={styles.settingsNav} aria-label="Settings sections" role="tablist" aria-orientation="vertical">
        <div class={styles.settingsNavEyebrow}>Preferences</div>
        <Button class={`${styles.settingsNavButton} ${section() === "appearance" ? styles.settingsNavButtonActive : ""}`} variant="ghost" role="tab" aria-selected={section() === "appearance"} aria-controls="settings-appearance-panel" onClick={() => setSection("appearance")}>
          <span class={`${styles.settingsNavIcon} ${section() === "appearance" ? styles.settingsNavIconActive : ""}`}><Palette size={16} aria-hidden="true" /></span><span class={styles.settingsNavCopy}><span>Appearance</span><span class={styles.settingsNavDetail}>Theme and color</span></span>
        </Button>
        <Button class={`${styles.settingsNavButton} ${section() === "workspace" ? styles.settingsNavButtonActive : ""}`} variant="ghost" role="tab" aria-selected={section() === "workspace"} aria-controls="settings-workspace-panel" onClick={() => setSection("workspace")}>
          <span class={`${styles.settingsNavIcon} ${section() === "workspace" ? styles.settingsNavIconActive : ""}`}><SlidersHorizontal size={16} aria-hidden="true" /></span><span class={styles.settingsNavCopy}><span>Workspace</span><span class={styles.settingsNavDetail}>Layout and behavior</span></span>
        </Button>
        <Button class={`${styles.settingsNavButton} ${section() === "agents" ? styles.settingsNavButtonActive : ""}`} variant="ghost" role="tab" aria-selected={section() === "agents"} aria-controls="settings-agents-panel" onClick={() => setSection("agents")}>
          <span class={`${styles.settingsNavIcon} ${section() === "agents" ? styles.settingsNavIconActive : ""}`}><Bot size={16} aria-hidden="true" /></span><span class={styles.settingsNavCopy}><span>Agents</span><span class={styles.settingsNavDetail}>Session visibility</span></span>
        </Button>
        <Button class={`${styles.settingsNavButton} ${section() === "usage" ? styles.settingsNavButtonActive : ""}`} variant="ghost" role="tab" aria-selected={section() === "usage"} aria-controls="settings-usage-panel" onClick={() => { setSection("usage"); props.refreshObservability() }}>
          <span class={`${styles.settingsNavIcon} ${section() === "usage" ? styles.settingsNavIconActive : ""}`}><Activity size={16} aria-hidden="true" /></span><span class={styles.settingsNavCopy}><span>Usage</span><span class={styles.settingsNavDetail}>Tokens and cost</span></span>
        </Button>
      </nav>

      <div class={styles.settingsPanel}>
        <Show when={section() === "appearance"}>
          <section id="settings-appearance-panel" class={styles.settingsSection} role="tabpanel" tabIndex="0" aria-labelledby="settings-appearance">
            <div class={styles.settingsSectionHeader}>
              <h2 id="settings-appearance" class={styles.settingsSectionTitle}>Appearance</h2>
              <p class={styles.settingsSectionDescription}>Set the visual language for your workspace.</p>
            </div>
             <ThemePicker light={draftTheme() === "light"} family={draftFamily()} onThemeChange={(theme) => { setDraftTheme(theme); props.onThemePreview(theme, draftFamily()) }} onFamilyChange={(family) => { setDraftFamily(family); props.onThemePreview(draftTheme(), family) }} />
          </section>
        </Show>

        <Show when={section() === "workspace"}>
          <section id="settings-workspace-panel" class={styles.settingsSection} role="tabpanel" tabIndex="0" aria-labelledby="settings-workspace">
            <div class={styles.settingsSectionHeader}>
              <h2 id="settings-workspace" class={styles.settingsSectionTitle}>Workspace</h2>
              <p class={styles.settingsSectionDescription}>Control the reading width and session navigation behavior.</p>
            </div>
            <div class={styles.settingsGroup}>
              <div class={styles.controlHeader}>
                <div class={styles.controlTitle}>Chat width</div>
                <div class={styles.controlHint}>Choose how much space messages can use.</div>
              </div>
              <div class={styles.widthOptions} role="group" aria-label="Chat width">
                <For each={chatWidthOptions}>{(option) => (
                  <Button class={`${styles.widthOption} ${draftChatWidth() === option.value ? styles.widthOptionActive : ""}`} variant="ghost" size="sm" aria-pressed={draftChatWidth() === option.value} onClick={() => setDraftChatWidth(option.value)}>
                    <span class={styles.widthOptionLabel}>{option.label}</span>
                    <span class={styles.widthOptionPreview} aria-hidden="true"><span style={{ width: option.preview }} /></span>
                  </Button>
                )}</For>
              </div>
              <div class={styles.controlHint}>{chatWidthOptions.find((option) => option.value === draftChatWidth())?.detail ?? "A balanced reading width."}</div>
            </div>
             <div class={styles.settingsGroup}>
             <label class={styles.settingRow}>
              <span class={styles.settingCopy}><span class={styles.settingTitle}>Keep sidebar open</span><span class={styles.settingDescription}>Keep the project and session list visible while working.</span></span>
               <span class={styles.toggle}><input class={styles.toggleInput} type="checkbox" checked={draftSidebarOpen()} onChange={(event) => setDraftSidebarOpen(event.currentTarget.checked)} /><span class={`${styles.toggleTrack} ${draftSidebarOpen() ? styles.toggleTrackChecked : ""}`} aria-hidden="true"><span class={`${styles.toggleThumb} ${draftSidebarOpen() ? styles.toggleThumbChecked : ""}`} /></span></span>
             </label>
             </div>
             <div class={styles.settingsGroup}>
               <label class={styles.settingRow}>
                 <span class={styles.settingCopy}><span class={styles.settingTitle}>Expand execution details</span><span class={styles.settingDescription}>Open reasoning, tool activity, and live execution sections by default.</span></span>
                 <span class={styles.toggle}><input class={styles.toggleInput} type="checkbox" checked={draftExpandChatDetails()} onChange={(event) => setDraftExpandChatDetails(event.currentTarget.checked)} /><span class={`${styles.toggleTrack} ${draftExpandChatDetails() ? styles.toggleTrackChecked : ""}`} aria-hidden="true"><span class={`${styles.toggleThumb} ${draftExpandChatDetails() ? styles.toggleThumbChecked : ""}`} /></span></span>
               </label>
             </div>
            <div class={styles.settingsGroup}>
              <div class={styles.settingsField}>
                <div class={styles.controlHeader}>
                  <div class={styles.controlTitle}>Media directories</div>
                  <div class={styles.controlHint}>Add existing paths inside your allowed workspace directories. Separate multiple paths with commas.</div>
                </div>
                 <Show when={mediaDirectoryValues().length > 0} fallback={<div class={styles.controlHint}>No media directories selected.</div>}>
                   <div class={styles.mediaDirectoryList} aria-label="Selected media directories">
                     <For each={mediaDirectoryValues()}>{(directory) => <div class={styles.mediaDirectoryChip}><span>{directory}</span><Button variant="ghost" size="sm" aria-label={`Remove ${directory}`} onClick={() => removeMediaDirectory(directory)}><X size={14} /></Button></div>}</For>
                   </div>
                 </Show>
                   <div class={styles.mediaDirectoryInputRow}>
                    <input class={styles.nativeInput} aria-label="Media directory path" placeholder="/absolute/path" value={mediaDirectoryDraft()} onInput={(event) => setMediaDirectoryDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTypedMediaDirectory() } }} />
                     <Button variant="outline" size="sm" disabled={mediaDirectoryDraft().trim().length === 0} onClick={addTypedMediaDirectory}>Add directory</Button>
                  </div>
                  <div class={styles.controlHint}>Only image files inside these directories can be rendered.</div>
                   <div class={styles.controlHint}>The path must exist and be readable by the web server.</div>
              </div>
            </div>
           </section>
         </Show>
          <Show when={section() === "agents"}>
           <section id="settings-agents-panel" class={styles.settingsSection} role="tabpanel" tabIndex="0" aria-labelledby="settings-agents">
             <div class={styles.settingsSectionHeader}>
               <h2 id="settings-agents" class={styles.settingsSectionTitle}>Agents</h2>
               <p class={styles.settingsSectionDescription}>Choose which agent-created sessions appear in your workspace.</p>
             </div>
              <div class={styles.settingsGroup}>
                <label class={styles.settingRow}>
                  <span class={styles.settingCopy}><span class={styles.settingTitle}>Hide subagent sessions</span><span class={styles.settingDescription}>Keep generated worker sessions out of the sidebar and session browser.</span></span>
                  <span class={styles.toggle}><input class={styles.toggleInput} type="checkbox" checked={draftHideSubagents()} onChange={(event) => setDraftHideSubagents(event.currentTarget.checked)} /><span class={`${styles.toggleTrack} ${draftHideSubagents() ? styles.toggleTrackChecked : ""}`} aria-hidden="true"><span class={`${styles.toggleThumb} ${draftHideSubagents() ? styles.toggleThumbChecked : ""}`} /></span></span>
                </label>
              </div>
              <div class={styles.settingsGroup}>
                <label class={styles.settingRow}>
                  <span class={styles.settingCopy}><span class={styles.settingTitle}>Show sessions from all projects</span><span class={styles.settingDescription}>Keep sessions from every configured project in the sidebar. Each session shows its project.</span></span>
                  <span class={styles.toggle}><input class={styles.toggleInput} type="checkbox" checked={draftShowAllSessions()} onChange={(event) => setDraftShowAllSessions(event.currentTarget.checked)} /><span class={`${styles.toggleTrack} ${draftShowAllSessions() ? styles.toggleTrackChecked : ""}`} aria-hidden="true"><span class={`${styles.toggleThumb} ${draftShowAllSessions() ? styles.toggleThumbChecked : ""}`} /></span></span>
                </label>
              </div>
           </section>
          </Show>
           <Show when={section() === "usage"}>
              <section id="settings-usage-panel" class={styles.settingsSection} role="tabpanel" tabIndex="0" aria-labelledby="settings-usage">
                <div class={styles.observabilityHeader}>
                  <div class={styles.settingsSectionHeader}>
                    <h2 id="settings-usage" class={styles.settingsSectionTitle}>Usage</h2>
                    <p class={styles.settingsSectionDescription}>Track tokens, cost, activity, and the workspaces using OpenCode.</p>
                  </div>
                  <Button variant="outline" size="sm" loading={props.observabilityLoading} loadingText="Refreshing…" onClick={props.refreshObservability}><RefreshCw size={14} aria-hidden="true" />Refresh usage</Button>
                </div>
                <Show when={props.observability} fallback={<div class={styles.settingsGroup} aria-live="polite"><div class={styles.controlTitle}>{props.observabilityLoading ? "Loading service usage…" : "No usage data is available"}</div><div class={styles.controlHint}>{props.observabilityLoading ? "Reading the configured OpenCode database." : "Refresh after you configure the usage database."}</div></div>}>{(snapshot) => <>
                  <Show when={snapshot().available} fallback={<div class={styles.usageUnavailable} role="status"><div class={styles.usageUnavailableMark}><Activity size={18} aria-hidden="true" /></div><div class={styles.usageUnavailableCopy}><strong>Usage is not connected</strong><span>{snapshot().warning ?? "Set the OpenCode database path to see usage here."}</span><code>OPENCODE_DATABASE_FILE</code></div></div>}>
                  <div class={styles.observabilitySummary}>
                   <div class={styles.observabilityHero}>
                     <span>Lifetime token usage</span>
                     <strong>{formatCompactNumber(snapshot().tokens.total)}</strong>
                     <div class={styles.observabilityHeroMeta}><span>{formatNumber(snapshot().tokens.total)} tokens</span><span>{formatCost(snapshot().tokens.cost)} reported cost</span></div>
                   </div>
                   <dl class={styles.observabilityStatRail}>
                     <div class={styles.observabilityStat}><dt>Sessions</dt><dd>{formatNumber(snapshot().sessions)}</dd><small>{formatNumber(snapshot().activeSessions)} active</small></div>
                     <div class={styles.observabilityStat}><dt>Workspaces</dt><dd>{formatNumber(snapshot().workspaces)}</dd><small>{formatNumber(snapshot().models)} models</small></div>
                     <div class={styles.observabilityStat}><dt>Agents</dt><dd>{formatNumber(snapshot().agents)}</dd><small>{formatNumber(snapshot().subagentSessions)} subagent sessions</small></div>
                     <div class={styles.observabilityStat}><dt>Usage database</dt><dd>{formatBytes(snapshot().databaseBytes)}</dd><small>OpenCode SQLite</small></div>
                   </dl>
                 </div>

                 <div class={styles.settingsGroup}>
                   <div class={styles.controlHeader}><div class={styles.controlTitle}>14-day activity</div><div class={styles.controlHint}>Tokens grouped by the session's most recent activity.</div></div>
                   <div class={styles.observabilityChart} role="img" aria-label={`Token activity over 14 days. Peak day ${formatNumber(Math.max(0, ...snapshot().daily.map((point) => point.tokens)))} tokens.`}>
                     <For each={snapshot().daily}>{(point) => {
                       const peak = () => Math.max(1, ...snapshot().daily.map((item) => item.tokens))
                       return <div class={styles.observabilityChartPoint} title={`${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(point.date)}: ${formatNumber(point.tokens)} tokens across ${formatNumber(point.sessions)} sessions`}><span class={styles.observabilityBar} style={{ height: `${Math.max(3, (point.tokens / peak()) * 100)}%` }} /><small>{formatDay(point.date)}</small></div>
                     }}</For>
                   </div>
                   <div class={styles.observabilityTableWrap}>
                     <table class={styles.observabilityTable}>
                       <caption class={styles.srOnly}>Usage by time period</caption>
                       <thead><tr><th>Period</th><th>Sessions</th><th>Tokens</th><th>Cache read</th><th>Cost</th></tr></thead>
                       <tbody>
                         <For each={[{ label: "Today", value: snapshot().today }, { label: "7 days", value: snapshot().lastWeek }, { label: "30 days", value: snapshot().lastMonth }]}>{(period) => <tr><th scope="row">{period.label}</th><td>{formatNumber(period.value.sessions)}</td><td>{formatCompactNumber(periodTokens(period.value))}</td><td>{formatCompactNumber(period.value.cacheRead)}</td><td>{formatCost(period.value.cost)}</td></tr>}</For>
                       </tbody>
                     </table>
                   </div>
                 </div>

                 <div class={styles.observabilitySectionGrid}>
                   <div class={styles.settingsGroup}>
                     <div class={styles.controlHeader}><div class={styles.controlTitle}>Token mix</div><div class={styles.controlHint}>Generated and cached context.</div></div>
                     <div class={styles.observabilityTokenList}>
                       <For each={[{ label: "Input", value: snapshot().tokens.input }, { label: "Output", value: snapshot().tokens.output }, { label: "Reasoning", value: snapshot().tokens.reasoning }, { label: "Cache read", value: snapshot().tokens.cacheRead }, { label: "Cache write", value: snapshot().tokens.cacheWrite }]}>{(token) => {
                         const peak = () => Math.max(1, snapshot().tokens.input, snapshot().tokens.output, snapshot().tokens.reasoning, snapshot().tokens.cacheRead, snapshot().tokens.cacheWrite)
                         return <div class={styles.observabilityTokenRow}><span>{token.label}</span><strong>{formatCompactNumber(token.value)}</strong><span class={styles.observabilityTokenBar} aria-hidden="true"><span style={{ width: `${(token.value / peak()) * 100}%` }} /></span></div>
                       }}</For>
                     </div>
                   </div>
                   <div class={styles.settingsGroup}>
                     <div class={styles.controlHeader}><div class={styles.controlTitle}>Session inventory</div><div class={styles.controlHint}>Primary, delegated, and archived work.</div></div>
                     <div class={styles.observabilityRows}>
                       <div><span>Primary</span><strong>{formatNumber(snapshot().primarySessions)}</strong></div>
                       <div><span>Subagent</span><strong>{formatNumber(snapshot().subagentSessions)}</strong></div>
                       <div><span>Archived</span><strong>{formatNumber(snapshot().archivedSessions)}</strong></div>
                       <div><span>Currently active</span><strong>{formatNumber(snapshot().activeSessions)}</strong></div>
                     </div>
                   </div>
                 </div>

                 <div class={styles.settingsGroup}>
                   <div class={styles.controlHeader}><div class={styles.controlTitle}>Top workspaces</div><div class={styles.controlHint}>Ranked by lifetime token usage.</div></div>
                   <Show when={snapshot().topWorkspaces.length > 0} fallback={<div class={styles.controlHint}>No workspace activity has been recorded.</div>}><div class={styles.observabilityTableWrap}><table class={styles.observabilityTable}><caption class={styles.srOnly}>Top workspaces by token usage</caption><thead><tr><th>Workspace</th><th>Sessions</th><th>Tokens</th><th>Active</th></tr></thead><tbody><For each={snapshot().topWorkspaces}>{(row) => <tr><th scope="row"><span class={styles.observabilityIdentity}>{row.label}<small title={row.detail}>{row.detail}</small></span></th><td>{formatNumber(row.sessions)}</td><td>{formatCompactNumber(row.tokens)}</td><td>{formatNumber(row.active)}</td></tr>}</For></tbody></table></div></Show>
                 </div>

                 <div class={styles.observabilitySectionGrid}>
                   <div class={styles.settingsGroup}>
                     <div class={styles.controlHeader}><div class={styles.controlTitle}>Model mix</div><div class={styles.controlHint}>Top models by token usage.</div></div>
                     <Show when={snapshot().topModels.length > 0} fallback={<div class={styles.controlHint}>No model usage has been recorded.</div>}><div class={styles.observabilityRankedList}><For each={snapshot().topModels}>{(row, index) => <div><span class={styles.observabilityRank}>{index() + 1}</span><span class={styles.observabilityIdentity}>{row.label}<small>{row.detail}</small></span><strong>{formatCompactNumber(row.tokens)}</strong></div>}</For></div></Show>
                   </div>
                   <div class={styles.settingsGroup}>
                     <div class={styles.controlHeader}><div class={styles.controlTitle}>Agent mix</div><div class={styles.controlHint}>Top agents by token usage.</div></div>
                     <Show when={snapshot().topAgents.length > 0} fallback={<div class={styles.controlHint}>No agent usage has been recorded.</div>}><div class={styles.observabilityRankedList}><For each={snapshot().topAgents}>{(row, index) => <div><span class={styles.observabilityRank}>{index() + 1}</span><span class={styles.observabilityIdentity}>{row.label}<small>{formatNumber(row.sessions)} sessions</small></span><strong>{formatCompactNumber(row.tokens)}</strong></div>}</For></div></Show>
                   </div>
                 </div>
                  <div class={styles.observabilityFreshness} aria-live="polite">Updated {formatTime(snapshot().generatedAt)} · All available OpenCode sessions included</div>
                 </Show>
                </>}</Show>
             </section>
           </Show>
            <Show when={section() !== "usage" || dirty()}><div class={styles.settingsFooter}>
             <div class={styles.settingsSaveHint}><Check size={14} aria-hidden="true" /> Changes stay local until you save.</div>
             <div class={styles.settingsFooterActions}>
               <Button size="sm" variant="outline" onClick={saveSettings}>Apply</Button>
               <Button size="sm" onClick={() => { saveSettings(); props.closeSettings() }}>Save &amp; close</Button>
             </div>
           </div></Show>
      </div>
    </div>
  )
}

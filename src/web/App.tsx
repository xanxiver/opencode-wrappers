import { For, Show, createEffect, createSignal, onMount } from "solid-js"
import { Effect, Fiber } from "effect"
import { Portal } from "solid-js/web"
import { ArrowDown, ArrowUp, Check, FolderGit2, Gauge, ListChecks, MessageSquare, Minimize2, Palette, PanelLeftOpen, Play, Plus, RotateCcw, ShieldAlert, Square, SquareTerminal, Star, Sun, Undo2, X } from "lucide-solid"
import { useAtomRegistry, useAtomValue } from "./state/atom-solid"
import { appStateAtom, createAppViewModel, type AppState, type Session, type ThemeFamily } from "./state/app-view-model"
import { css } from "./styled-system/css"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { PickerCombobox } from "./components/picker-combobox"
import { ThemePicker } from "./components/theme-picker"
import { Composer } from "./components/workspace/Composer"
import { ConversationPane } from "./components/workspace/ConversationPane"
import { Sidebar } from "./components/workspace/Sidebar"
import { Dialog } from "./components/ui/dialog"
import { Alert } from "./components/ui/alert"
import { Drawer } from "./components/ui/drawer"
import { SettingsDialog } from "./components/settings/SettingsDialog"
import { QueueDialog } from "./components/workspace/QueueDialog"
import { AppViewModelError, loginWeb, loadWebSession, makeAppEffectRunner } from "./state/api-client"

const styles = {
  shell: css({ minH: "100dvh", h: "100dvh", overflow: "hidden", bg: "var(--coffee-canvas)", color: "var(--coffee-text)", display: "flex", flexDir: "column", fontFamily: "var(--font-sans)" }),
  layout: css({ position: "relative", flex: "1", minH: "0", display: "flex", overflow: "hidden" }),
  sidebarPanel: css({ w: { base: "292px", "2xl": "320px" }, overflow: "hidden", flexShrink: "0", bg: "var(--coffee-sidebar)", borderRight: "1px solid", borderColor: "var(--coffee-border)", px: { base: "3", "2xl": "4" }, py: "5", display: "flex", flexDir: "column", gap: "5" }),
  sidebar: css({ position: "absolute", zIndex: "20", insetBlock: "0", left: "0" }),
  closedSidebar: css({ w: "0", px: "0", borderRightWidth: "0", opacity: "0", pointerEvents: "none", boxShadow: "none" }),
  drawerBackdrop: css({ bg: "var(--coffee-backdrop)", backdropFilter: "blur(6px)" }),
  drawerPositioner: css({ zIndex: "1400", justifyContent: "flex-start" }),
  drawerContent: css({ position: "relative", h: "100dvh", maxW: "min(320px, calc(100vw - 48px))", color: "var(--coffee-text)", outline: "none" }),
  drawerClose: css({ minW: "11", h: "11", flexShrink: "0", color: "var(--coffee-accent)" }),
  srOnly: css({ position: "absolute", w: "1px", h: "1px", p: "0", m: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: "0" }),
  sidebarHeader: css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "2" }),
  sidebarCollapse: css({ minW: "11", h: "11", flexShrink: "0", color: "var(--coffee-text-muted)", _hover: { color: "var(--coffee-text)", bg: "var(--coffee-surface-raised)" } }),
  brand: css({ display: "flex", alignItems: "center", gap: "3", px: "2", fontSize: "md", fontWeight: "semibold", letterSpacing: "tight", color: "var(--coffee-text)" }),
  brandIcon: css({ display: "grid", placeItems: "center", w: "8", h: "8", borderRadius: "10px", bg: "var(--coffee-accent)", color: "var(--coffee-on-accent)", boxShadow: "0 5px 18px var(--coffee-glow)" }),
  sidebarText: css({ overflow: "hidden", whiteSpace: "nowrap" }),
  sidebarDetails: css({ flex: "1", minH: "0", display: "flex", flexDir: "column", gap: "5" }),
  newSession: css({ w: "full", justifyContent: "center", gap: "2", mt: "2", borderColor: "var(--coffee-border)", bg: "var(--coffee-surface)", color: "var(--coffee-text)", _hover: { bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-accent)", boxShadow: "0 8px 18px var(--coffee-shadow)" } }),
  workspace: css({ display: "flex", flexDir: "column", gap: "3", p: "3", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "xl", bg: "transparent" }),
  label: css({ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: "semibold", color: "var(--coffee-text-muted)" }),
  selectRow: css({ display: "flex", alignItems: "center", gap: "2" }),
  selectIcon: css({ color: "var(--coffee-accent)", flexShrink: "0" }),
  sessionsHeader: css({ display: "flex", alignItems: "baseline", justifyContent: "space-between", px: "2" }),
  count: css({ fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)", fontVariantNumeric: "tabular-nums" }),
  sessions: css({ flex: "1", minH: "0", display: "flex", flexDir: "column" }),
  sessionList: css({ flex: "1", mt: "2", minH: "0" }),
  sessionListContent: css({ w: "full", minW: "0", maxW: "full", overflow: "hidden", display: "flex", flexDir: "column", gap: "1.5" }),
  sessionGroup: css({ display: "flex", flexDir: "column", gap: "1" }),
  sessionGroupLabel: css({ display: "flex", alignItems: "center", gap: "1.5", w: "full", minH: "7", px: "2", pt: "2", pb: "1", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase" }),
  sessionGroupToggle: css({ w: "full", minH: "7", justifyContent: "flex-start", gap: "1.5", px: "0", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs", _hover: { color: "var(--coffee-text)", bg: "transparent" } }),
  sessionGroupIcon: css({ color: "var(--coffee-accent-strong)" }),
  sessionBrowseButton: css({ w: "full", mt: "2", justifyContent: "space-between", borderColor: "var(--coffee-border)", color: "var(--coffee-accent-strong)", _hover: { bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-border-strong)" } }),
  allSessions: css({ display: "flex", flexDir: "column", gap: "1" }),
  allSessionsGroup: css({ mt: "2", mb: "1", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  sessionRow: css({ w: "full", maxW: "full", minW: "0", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 36px", alignItems: "stretch", gap: "1", borderRadius: "lg" }),
  sessionMain: css({ minW: "0", h: "auto", minH: "15", justifyContent: "flex-start", alignItems: "flex-start", textAlign: "left", border: "1px solid transparent", borderRadius: "lg", px: "2.5", py: "2.5", gap: "2.5", bg: "transparent", color: "var(--coffee-text-muted)", transition: "background 120ms ease, border-color 120ms ease, color 120ms ease", _hover: { bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)" } }),
   sessionIconWrap: css({ mt: "0.5", flexShrink: "0", display: "grid", placeItems: "center", color: "var(--coffee-text-muted)" }),
   sessionTitleRow: css({ minW: "0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "2" }),
   activeSessionPulse: css({ display: "block", w: "2", h: "2", flexShrink: "0", borderRadius: "full", bg: "var(--coffee-status)", boxShadow: "0 0 0 2px var(--coffee-surface)", animation: "pulse 1.4s ease-in-out infinite" }),
  favoriteButton: css({ minW: "9", w: "9", h: "9", mt: "1.5", p: "0", flexShrink: "0", alignSelf: "start", color: "var(--coffee-text-muted)", _hover: { color: "var(--coffee-accent-strong)", bg: "var(--coffee-surface-raised)" } }),
  favoriteButtonActive: css({ color: "var(--coffee-accent-strong)" }),
  session: css({ w: "full", h: "auto", minH: "12", justifyContent: "flex-start", textAlign: "left", borderRadius: "lg", p: "3", gap: "3", bg: "transparent", color: "var(--coffee-text-muted)", transition: "background 120ms ease, color 120ms ease", _hover: { bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)" } }),
  activeSession: css({ bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-border-strong)", color: "var(--coffee-text)" }),
  sessionCopy: css({ minW: "0", flex: "1", overflow: "hidden" }),
  sessionTitle: css({ lineClamp: "2", whiteSpace: "normal", fontSize: "sm", fontWeight: "medium", lineHeight: "1.35", textWrap: "pretty" }),
  sessionDetail: css({ display: "block", fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--coffee-text-muted)", mt: "1.5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
  main: css({ flex: "1", minW: "0", display: "flex", flexDir: "column", bg: "transparent" }),
  projectStart: css({ position: "relative", flex: "1", minH: "0", display: "grid", placeItems: "center", px: { base: "5", md: "10" }, py: { base: "16", md: "16" } }),
  projectStartTopbar: css({ position: "absolute", top: { base: "3", md: "5" }, right: { base: "3", md: "8" }, display: "flex", alignItems: "center", gap: "2" }),
  projectStartContent: css({ w: "full", maxW: "560px", display: "flex", flexDir: "column", gap: "4" }),
  projectStartMark: css({ display: "grid", placeItems: "center", w: "12", h: "12", borderRadius: "xl", bg: "var(--coffee-accent)", color: "var(--coffee-on-accent)", boxShadow: "0 8px 24px var(--coffee-glow)" }),
  projectStartTitle: css({ fontSize: { base: "2xl", md: "3xl" }, fontWeight: "semibold", letterSpacing: "tight", color: "var(--coffee-text)" }),
  projectStartText: css({ maxW: "480px", color: "var(--coffee-text-muted)", lineHeight: "1.65", textWrap: "pretty" }),
  projectLoadingLines: css({ display: "flex", flexDir: "column", gap: "2", maxW: "360px" }),
  projectStartField: css({ display: "flex", flexDir: "column", gap: "2", p: { base: "4", md: "5" }, border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "xl", bg: "var(--coffee-surface)", boxShadow: "0 16px 36px var(--coffee-shadow)" }),
  mainWithSidebar: css({ pl: "292px" }),
  header: css({ position: "relative", zIndex: "30", h: "20", flexShrink: "0", px: { base: "4", md: "10" }, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "3", borderBottom: "1px solid", borderColor: "var(--coffee-border)", bg: "var(--coffee-surface)", backdropFilter: "blur(14px)" }),
  headerStart: css({ display: "flex", alignItems: "center", gap: "3", minW: "0" }),
  sidebarToggle: css({ flexShrink: "0", minW: { base: "11", md: "auto" }, h: { base: "11", md: "9" }, color: "var(--coffee-accent)", _hover: { color: "var(--coffee-accent-strong)", bg: "var(--coffee-surface-raised)" } }),
  headerTitle: css({ display: "flex", flexDir: "column", gap: "1", minW: "0" }),
  title: css({ fontSize: "md", fontWeight: "semibold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
  subtitle: css({ fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)" }),
  status: css({ display: "inline-flex", alignItems: "center", gap: "2", fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)", flexShrink: "0" }),
  dot: css({ w: "2", h: "2", borderRadius: "full", bg: "var(--coffee-status)" }),
  disconnectedDot: css({ bg: "var(--coffee-danger-border)" }),
  reconnectingDot: css({ bg: "var(--coffee-accent-strong)", animation: "pulse 1.4s ease-in-out infinite" }),
   conversation: css({ position: "relative", flex: "1", minH: "0", w: "full", mx: "auto", px: { base: "4", md: "10" }, py: { base: "4", md: "6" }, display: "flex", flexDir: "column", gap: "3" }),
  chatContentRail: css({ w: "full", mx: "auto", display: "flex", flexDir: "column", gap: "3" }),
  chatWidthWide: css({ maxW: "1180px" }),
  chatWidthFull: css({ maxW: "none" }),
  chatWidthNormal: css({ maxW: "920px" }),
  chatWidthNarrow: css({ maxW: "720px" }),
  messageList: css({ w: "full", display: "flex", flexDir: "column", gap: "3" }),
  virtualMessageList: css({ position: "relative", w: "full" }),
  virtualMessageRow: css({ position: "absolute", top: "0", left: "0", w: "full" }),
  messageRow: css({ w: "full", display: "flex", minH: "0" }),
  assistantRow: css({ justifyContent: "flex-start" }),
  userRow: css({ justifyContent: "flex-end" }),
  message: css({ minW: { base: "min(100%, 280px)", md: "320px" }, maxW: "full", borderRadius: "xl", p: "0", lineHeight: "1.65", border: "1px solid", overflow: "hidden" }),
  messageBody: css({ minW: "0", px: "4", pt: "3", pb: "4", display: "flex", flexDir: "column" }),
  messageMeta: css({ display: "flex", alignItems: "center", gap: "2", px: "4", pt: "3", fontSize: "xs", color: "var(--coffee-text-muted)" }),
  empty: css({ alignSelf: "center", display: "flex", flexDir: "column", alignItems: "center", justifyContent: "center", gap: "3", minH: { base: "260px", md: "300px" }, w: "100%", maxW: "520px", px: "5", textAlign: "center", color: "var(--coffee-text-muted)" }),
  emptyInner: css({ w: "full", maxW: "640px", display: "flex", flexDir: "column", alignItems: { base: "center", md: "flex-start" }, gap: "3", textAlign: { base: "center", md: "left" } }),
  emptyIcon: css({ display: "grid", placeItems: "center", w: "14", h: "14", mb: "2", borderRadius: "xl", border: "1px solid", borderColor: "var(--coffee-border)", bg: "var(--coffee-surface-raised)", color: "var(--coffee-accent)", boxShadow: "0 0 0 8px var(--coffee-glow)" }),
  emptyTitle: css({ color: "var(--coffee-text)", fontSize: "lg", fontWeight: "semibold" }),
  emptyText: css({ maxW: "480px", fontSize: "sm", lineHeight: "1.6", color: "var(--coffee-text-muted)", textWrap: "pretty" }),
  emptyActions: css({ display: "flex", flexWrap: "wrap", gap: "2", mt: "2", justifyContent: { base: "center", md: "flex-start" } }),
  emptyAction: css({ minH: "11" }),
  projectGate: css({ w: "full", p: { base: "4", md: "5" }, border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "xl", bg: "var(--coffee-surface)", boxShadow: "0 12px 28px var(--coffee-shadow)" }),
  projectGateTitle: css({ display: "flex", alignItems: "center", gap: "2", color: "var(--coffee-text)", fontWeight: "semibold" }),
  projectGateDetail: css({ mt: "2", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.6" }),
  assistant: css({ alignSelf: "flex-start", maxW: "full", bg: "transparent", borderColor: "transparent", color: "var(--coffee-text)", boxShadow: "none" }),
  user: css({ alignSelf: "flex-end", maxW: "92%", bg: "var(--coffee-user)", borderColor: "var(--coffee-border-strong)", color: "var(--coffee-text)", boxShadow: "0 8px 22px var(--coffee-shadow)" }),
  composerWrap: css({ w: "full", mx: "auto", px: { base: "4", md: "10" }, pb: { base: "4", md: "5" } }),
  composerStack: css({ display: "flex", flexDir: "column", overflow: "hidden", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "2xl", bg: "var(--coffee-surface)", boxShadow: "0 12px 28px var(--coffee-shadow)" }),
  composer: css({ borderTop: "1px solid", borderColor: "var(--coffee-border)", p: "3", display: "flex", alignItems: "center", gap: "3", bg: "transparent" }),
  composerControls: css({ w: "full", maxW: "full", display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: "1.5", p: { base: "2", md: "2" }, bg: "transparent" }),
  widthControl: css({ display: "flex", flexDir: "column", gap: "1", mr: { base: "0", md: "2" } }),
  widthControlLabel: css({ color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px" }),
  widthControlButtons: css({ display: "inline-flex", alignItems: "center", gap: "1", p: "1", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-canvas)" }),
  widthControlButton: css({ minH: "9", px: "3", borderRadius: "md", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs", _hover: { bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)" } }),
   widthControlButtonActive: css({ bg: "var(--coffee-glow)", color: "var(--coffee-accent-strong)", border: "1px solid", borderColor: "var(--coffee-accent-strong)" }),
  composerControl: css({ minW: "0", minH: "9", maxW: { base: "100%", md: "260px" }, flex: { base: "1 1 100%", sm: "1 1 auto" }, justifyContent: "flex-start", gap: "2", border: "1px solid transparent", borderRadius: "lg", px: "3", color: "var(--coffee-text-muted)", _hover: { bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)" }, _focusVisible: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "1px" } }),
  composerControlCopy: css({ minW: "0", display: "flex", flexDir: "column", alignItems: "flex-start", overflow: "hidden" }),
  composerControlLabel: css({ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--coffee-text-muted)" }),
  composerControlValue: css({ maxW: "full", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text)", fontSize: "sm" }),
  composerHotkey: css({ ml: "auto", flexShrink: "0", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", whiteSpace: "nowrap" }),
  input: css({ flex: "1", minW: "0", minH: "11", maxH: "36", display: "block", py: "2", bg: "transparent", border: "none", outline: "none", color: "var(--coffee-text)", font: "inherit", lineHeight: "1.5", resize: "none", _placeholder: { color: "var(--coffee-text-muted)" } }),
  hint: css({ display: "flex", flexDir: { base: "column", md: "row" }, justifyContent: "space-between", gap: "1", px: "2", pt: "2", fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)" }),
  hintSecondary: css({ display: { base: "none", md: "inline" } }),
  sendButton: css({ minH: "11", flexShrink: "0" }),
  stopButton: css({ minH: "11", flexShrink: "0", borderColor: "var(--coffee-danger-border)", bg: "var(--coffee-danger-surface)", color: "var(--coffee-danger-text)", _hover: { borderColor: "var(--coffee-danger-text)", bg: "var(--coffee-danger-surface)" } }),
  lightShell: css({ bg: "var(--coffee-canvas)", color: "var(--coffee-text)" }),
  lightSidebar: css({ bg: "var(--coffee-sidebar)", borderColor: "var(--coffee-border)" }),
  lightBrand: css({ color: "var(--coffee-text)" }),
  lightNewSession: css({ borderColor: "var(--coffee-border)", bg: "var(--coffee-surface)", color: "var(--coffee-text)" }),
  lightWorkspace: css({ bg: "var(--coffee-surface)", borderColor: "var(--coffee-border)" }),
  lightSelect: css({ color: "var(--coffee-text)" }),
  lightSession: css({ color: "var(--coffee-text-muted)" }),
  lightActiveSession: css({ bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)" }),
  lightMain: css({ bg: "transparent" }),
  lightHeader: css({ bg: "var(--coffee-surface)", borderColor: "var(--coffee-border)" }),
  lightTitle: css({ color: "var(--coffee-text)" }),
  lightAssistant: css({ bg: "transparent", borderColor: "transparent", color: "var(--coffee-text)", boxShadow: "none" }),
  lightUser: css({ bg: "var(--coffee-user)", borderColor: "var(--coffee-border-strong)", color: "var(--coffee-text)" }),
  lightComposer: css({ bg: "var(--coffee-surface)", borderColor: "var(--coffee-border)", boxShadow: "0 18px 40px var(--coffee-shadow)" }),
  lightInput: css({ color: "var(--coffee-text)", _placeholder: { color: "var(--coffee-text-muted)" } }),
  lightHint: css({ color: "var(--coffee-text-muted)" }),
  pickerTrigger: css({ minW: "0", minH: { base: "11", md: "9" }, flex: "1", justifyContent: "flex-start", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "0", bg: "transparent", color: "var(--coffee-text)", fontSize: "sm", _hover: { bg: "var(--coffee-surface-raised)" } }),
  variantRow: css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "3", pl: "6" }),
  variantLabel: css({ fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)" }),
  variantTrigger: css({ minW: "0", minH: { base: "11", md: "8" }, maxW: "140px", justifyContent: "flex-end", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "0", bg: "transparent", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "xs", _hover: { bg: "var(--coffee-surface-raised)" } }),
  commandGrid: css({ display: "grid", gridTemplateColumns: "1fr", gap: "2", w: "full" }),
   commandDialogContent: css({ w: "min(560px, calc(100vw - 24px))", maxH: "min(640px, calc(100dvh - 32px))", overflow: "hidden" }),
   projectDialogContent: css({ w: "min(680px, calc(100vw - 24px))", maxH: "min(720px, calc(100dvh - 32px))", overflow: "hidden" }),
   projectPickerIntro: css({ display: "flex", flexDir: { base: "column", md: "row" }, alignItems: { base: "flex-start", md: "flex-end" }, justifyContent: "space-between", gap: { base: "2", md: "4" }, mb: "4", px: "1", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.5" }),
   projectPickerIntroCopy: css({ maxW: "48ch" }),
   projectPickerCount: css({ flexShrink: "0", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "xs", whiteSpace: "nowrap" }),
   projectAddRow: css({ display: "flex", alignItems: "flex-end", gap: "2", mt: "4", pt: "4", borderTop: "1px solid", borderColor: "var(--coffee-border)" }),
   projectAddField: css({ flex: "1", minW: "0", display: "flex", flexDir: "column", gap: "1.5" }),
   projectAddLabel: css({ color: "var(--coffee-text-muted)", fontSize: "xs", fontWeight: "medium" }),
   projectAddInput: css({ w: "full", minH: "11", px: "3", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "lg", bg: "var(--coffee-canvas)", color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: "xs", outline: "none", _focusVisible: { borderColor: "var(--coffee-accent)", boxShadow: "0 0 0 2px var(--coffee-glow)" }, _placeholder: { color: "var(--coffee-text-muted)" } }),
   observabilityHeader: css({ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "4", "& > button": { flexShrink: "0" } }),
   usageUnavailable: css({ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", gap: "3", p: { base: "4", md: "5" }, border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "xl", bg: "var(--coffee-canvas)" }),
   usageUnavailableMark: css({ display: "grid", placeItems: "center", w: "9", h: "9", borderRadius: "lg", bg: "var(--coffee-glow)", color: "var(--coffee-accent-strong)" }),
   usageUnavailableCopy: css({ minW: "0", display: "flex", flexDir: "column", gap: "1.5", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.55", "& strong": { color: "var(--coffee-text)", fontSize: "md" }, "& code": { alignSelf: "flex-start", mt: "1", px: "2", py: "1", borderRadius: "sm", bg: "var(--coffee-surface-raised)", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "10px" } }),
    observabilitySummary: css({ display: "grid", gridTemplateColumns: { base: "1fr", md: "minmax(220px, 0.85fr) minmax(0, 1.6fr)" }, border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "xl", overflow: "hidden", bg: "var(--coffee-canvas)" }),
    observabilityHero: css({ minW: "0", display: "flex", flexDir: "column", justifyContent: "center", gap: "1", p: { base: "4", md: "5" }, borderBottom: { base: "1px solid", md: "0" }, borderRight: { base: "0", md: "1px solid" }, borderColor: "var(--coffee-border)", color: "var(--coffee-text-muted)", fontSize: "xs", "& > strong": { color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: { base: "3xl", md: "4xl" }, fontWeight: "semibold", letterSpacing: "-0.04em", lineHeight: "1.1", fontVariantNumeric: "tabular-nums" } }),
    observabilityHeroMeta: css({ display: "flex", flexWrap: "wrap", gap: "1 3", mt: "2", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", fontVariantNumeric: "tabular-nums" }),
    observabilityStatRail: css({ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", m: "0" }),
    observabilityStat: css({ minW: "0", display: "flex", flexDir: "column", gap: "0.5", p: { base: "3", md: "4" }, borderBottom: "1px solid", borderRight: "1px solid", borderColor: "var(--coffee-border)", "&:nth-child(2n)": { borderRight: "0" }, "&:nth-last-child(-n+2)": { borderBottom: "0" }, "& dt": { color: "var(--coffee-text-muted)", fontSize: "xs" }, "& dd": { m: "0", color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: "lg", fontWeight: "semibold", fontVariantNumeric: "tabular-nums" }, "& small": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text-muted)", fontSize: "10px" } }),
    observabilitySectionGrid: css({ display: "grid", gridTemplateColumns: { base: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: "3", alignItems: "start" }),
   observabilityRows: css({ display: "grid", gridTemplateColumns: { base: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: "0", "& > div": { display: "flex", justifyContent: "space-between", gap: "3", py: "2", borderTop: "1px solid", borderColor: "var(--coffee-border)", color: "var(--coffee-text-muted)", fontSize: "xs" }, "& > div:first-child": { borderTop: "0" }, "& strong": { color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontWeight: "medium" } }),
    observabilityChart: css({ h: "32", display: "grid", gridTemplateColumns: "repeat(14, minmax(0, 1fr))", alignItems: "end", gap: "1", pt: "3", borderBottom: "1px solid", borderColor: "var(--coffee-border)" }),
    observabilityChartPoint: css({ minW: "0", h: "full", display: "flex", flexDir: "column", alignItems: "stretch", justifyContent: "flex-end", gap: "1", "& small": { color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "9px", textAlign: "center" } }),
    observabilityBar: css({ minH: "1", borderRadius: "2px 2px 0 0", bg: "var(--coffee-accent-strong)", opacity: "0.78", transition: "opacity 140ms ease", _hover: { opacity: "1" } }),
    observabilityTableWrap: css({ w: "full", overflowX: "auto", overscrollBehavior: "contain" }),
    observabilityTable: css({ w: "full", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", "& th, & td": { px: "2", py: "2", borderBottom: "1px solid", borderColor: "var(--coffee-border)", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "xs", whiteSpace: "nowrap" }, "& thead th": { color: "var(--coffee-text-muted)", fontSize: "10px", fontWeight: "medium" }, "& th:first-child, & td:first-child": { pl: "0", textAlign: "left" }, "& th:last-child, & td:last-child": { pr: "0" }, "& tbody th": { maxW: "280px", color: "var(--coffee-text)", fontWeight: "medium" }, "& tbody td": { color: "var(--coffee-text)" }, "& tbody tr:last-child th, & tbody tr:last-child td": { borderBottom: "0" } }),
    observabilityTokenList: css({ display: "flex", flexDir: "column", gap: "2" }),
    observabilityTokenRow: css({ display: "grid", gridTemplateColumns: "88px minmax(0, 1fr) 56px", alignItems: "center", gap: "2", color: "var(--coffee-text-muted)", fontSize: "xs", "& > strong": { gridColumn: "3", gridRow: "1", color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontWeight: "medium", textAlign: "right", fontVariantNumeric: "tabular-nums" } }),
    observabilityTokenBar: css({ gridColumn: "2", gridRow: "1", h: "1.5", overflow: "hidden", borderRadius: "full", bg: "var(--coffee-surface-raised)", "& > span": { display: "block", h: "full", borderRadius: "full", bg: "var(--coffee-accent-strong)", opacity: "0.72" } }),
    observabilityRankedList: css({ display: "flex", flexDir: "column", "& > div": { minW: "0", display: "grid", gridTemplateColumns: "20px minmax(0, 1fr) auto", alignItems: "center", gap: "2", py: "2", borderBottom: "1px solid", borderColor: "var(--coffee-border)" }, "& > div:last-child": { borderBottom: "0" }, "& strong": { color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: "xs", fontWeight: "medium", fontVariantNumeric: "tabular-nums" } }),
    observabilityRank: css({ color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px" }),
    observabilityIdentity: css({ minW: "0", display: "flex", flexDir: "column", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: "xs", "& small": { maxW: "full", overflow: "hidden", textOverflow: "ellipsis", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: "normal" } }),
    observabilityFreshness: css({ color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", textAlign: "right" }),
  commandBody: css({ minH: "0", overflow: "hidden" }),
  commandList: css({ minH: "0", flex: "1", display: "flex", flexDir: "column", gap: "1", w: "full", overflowY: "auto", overscrollBehavior: "contain", pr: "1" }),
  pickerSelect: css({ position: "relative", w: "full", minW: "0", minH: "11", justifyContent: "flex-start", gap: "3", border: "1px solid transparent", borderRadius: "md", bg: "transparent", color: "var(--coffee-text)", px: "3", outline: "none", transition: "background 160ms ease, border-color 160ms ease, transform 160ms ease", _hover: { bg: "var(--coffee-surface)", borderColor: "var(--coffee-border)" }, _active: { transform: "scale(0.99)" }, _focusVisible: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "-2px" }, "&[disabled]": { opacity: "0.38", cursor: "not-allowed" } }),
  commandActive: css({ bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-accent-strong)" }),
  commandKeys: css({ display: "inline-flex", alignItems: "center", gap: "0.5", ml: "auto", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", whiteSpace: "nowrap", opacity: "0.8" }),
  commandEmpty: css({ display: "flex", flexDir: "column", gap: "1", p: "5", border: "1px dashed", borderColor: "var(--coffee-border-strong)", borderRadius: "md", color: "var(--coffee-text-muted)", textAlign: "center", fontSize: "sm" }),
  commandEmptyTitle: css({ color: "var(--coffee-text)", fontWeight: "semibold" }),
  variantOptions: css({ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1", p: "1", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-canvas)" }),
  variantOption: css({ minH: "11", minW: "0", display: "flex", flexDir: "column", alignItems: "flex-start", justifyContent: "center", gap: "0.5", px: "3", borderRadius: "md", color: "var(--coffee-text-muted)", textAlign: "left", _hover: { bg: "var(--coffee-surface)", color: "var(--coffee-text)" } }),
   variantOptionActive: css({ bg: "var(--coffee-glow)", color: "var(--coffee-accent-strong)", border: "1px solid", borderColor: "var(--coffee-accent-strong)" }),
  pickerSelectIcon: css({ flexShrink: "0", color: "var(--coffee-accent-strong)" }),
  pickerSelectCopy: css({ minW: "0", display: "flex", flexDir: "column", alignItems: "flex-start", gap: "0.5", textAlign: "left" }),
  pickerSelectTitle: css({ maxW: "full", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "medium" }),
   pickerSelectDetail: css({ maxW: "full", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  dialogTitleRow: css({ display: "flex", alignItems: "center", gap: "3" }),
  breadcrumb: css({ display: "flex", alignItems: "center", gap: "1", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  shortcutBadge: css({ flexShrink: "0", fontFamily: "var(--font-mono)" }),
  dialogClose: css({ minH: { base: "11", md: "9" } }),
  revertSummary: css({ maxH: "28", overflow: "hidden", p: "3", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-canvas)", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.55", whiteSpace: "pre-wrap" }),
  revertWarning: css({ color: "var(--coffee-danger-text)", fontSize: "sm", lineHeight: "1.55" }),
  revertActions: css({ display: "flex", justifyContent: "flex-end", gap: "2", mt: "4" }),
  optionCopy: css({ minW: "0", maxW: "full", display: "flex", flexDir: "column", alignItems: "flex-start", gap: "0.5", overflow: "hidden" }),
  optionDetail: css({ w: "full", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  optionGroup: css({ px: "3", pt: "3", pb: "1", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: "semibold", letterSpacing: "0.08em", textTransform: "uppercase" }),
  optionActive: css({ color: "var(--coffee-status)", fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.05em", textTransform: "uppercase" }),
  themeDialogContent: css({ w: "min(860px, calc(100vw - 24px))", maxH: "min(780px, calc(100dvh - 24px))" }),
  settingsDialogContent: css({ w: "min(1080px, calc(100vw - 32px))", maxW: "min(1080px, calc(100vw - 32px))", maxH: "min(820px, calc(100dvh - 32px))", overflow: "hidden" }),
  unavailableModel: css({ display: "flex", flexDir: "column", gap: "1", mt: "3", p: "3", border: "1px solid", borderColor: "var(--coffee-danger-border)", borderRadius: "lg", bg: "var(--coffee-danger-surface)", color: "var(--coffee-danger-text)", fontSize: "sm" }),
  unavailableDetail: css({ color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs", overflowWrap: "anywhere" }),
  errorBanner: css({ w: "auto", mx: { base: "4", md: "10" }, mt: "3", px: "3", py: "2", border: "1px solid", borderColor: "var(--coffee-danger-border)", borderRadius: "lg", bg: "var(--coffee-danger-surface)", color: "var(--coffee-danger-text)", fontSize: "sm" }),
  errorDismiss: css({ ml: "auto", minH: { base: "11", md: "9" }, flexShrink: "0" }),
  headerActions: css({ display: "flex", alignItems: "center", gap: "1" }),
  utilityRail: css({ minH: "12", px: { base: "3", md: "8" }, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", alignItems: "center", gap: "3", flexShrink: "0" }),
  utilityStart: css({ minW: "0", justifySelf: "start" }),
  utilityEnd: css({ minW: "0", justifySelf: "end" }),
  utilityTitle: css({ minW: "0", maxW: { base: "min(46vw, 280px)", md: "min(46vw, 560px)" }, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center", fontSize: { base: "md", md: "lg" }, fontWeight: "semibold", letterSpacing: "tight", color: "var(--coffee-text)" }),
  controlButton: css({ minW: { base: "11", md: "auto" }, color: "var(--coffee-text-muted)", _hover: { color: "var(--coffee-text)", bg: "var(--coffee-surface-raised)" } }),
   runStrip: css({ w: "full", mx: "auto", px: { base: "4", md: "10" }, pt: "3", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2", fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)" }),
   queueButton: css({ minH: "8", gap: "1.5", borderColor: "var(--coffee-border)", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "xs", _hover: { bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-accent-strong)" } }),
   queueDialogContent: css({ w: "min(620px, calc(100vw - 24px))", maxH: "min(680px, calc(100dvh - 32px))" }),
   queueList: css({ display: "flex", flexDir: "column", gap: "2", maxH: "min(52dvh, 420px)", overflowY: "auto" }),
   queueItem: css({ display: "flex", alignItems: "center", gap: "3", minW: "0", p: "3", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-canvas)" }),
   queueItemCopy: css({ minW: "0", flex: "1", display: "flex", flexDir: "column", gap: "1" }),
   queueItemIndex: css({ color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }),
   queueItemText: css({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text)", fontSize: "sm" }),
   queueItemDetail: css({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px" }),
   queueRemove: css({ minW: "9", h: "9", flexShrink: "0", color: "var(--coffee-text-muted)", _hover: { color: "var(--coffee-danger-text)", bg: "var(--coffee-surface-raised)" } }),
   queueEmpty: css({ p: "5", border: "1px dashed", borderColor: "var(--coffee-border-strong)", borderRadius: "lg", color: "var(--coffee-text-muted)", textAlign: "center" }),
   pendingArea: css({ w: "full", maxH: "min(32dvh, 360px)", overflowY: "auto", mx: "auto", px: { base: "4", md: "10" }, pt: "2", pb: "3", display: "flex", flexDir: "column", gap: "2" }),
  pendingToggle: css({ alignSelf: "flex-start", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
   requestCard: css({ p: "3", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "xl", bg: "var(--coffee-surface-raised)", display: "flex", flexDir: "column", gap: "3" }),
   questionCard: css({ p: { base: "3", md: "4" }, gap: "3.5", borderColor: "var(--coffee-accent)", boxShadow: "0 10px 28px var(--coffee-shadow)" }),
   requestHeader: css({ display: "flex", alignItems: "center", gap: "2", fontWeight: "semibold" }),
   questionHeader: css({ display: "flex", alignItems: "flex-start", gap: "3" }),
   questionHeaderIcon: css({ display: "grid", placeItems: "center", w: "9", h: "9", flexShrink: "0", borderRadius: "lg", bg: "var(--coffee-accent)", color: "var(--coffee-on-accent)" }),
   questionHeaderCopy: css({ display: "flex", flexDir: "column", gap: "0.5" }),
   questionEyebrow: css({ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--coffee-accent-strong)" }),
   questionDescription: css({ color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.45" }),
  requestDetail: css({ fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)", overflowWrap: "anywhere" }),
  requestActions: css({ display: "flex", flexWrap: "wrap", gap: "2" }),
   questionBlock: css({ minW: "0", display: "flex", flexDir: "column", gap: "2.5", p: { base: "3", md: "3.5" }, border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-canvas)" }),
   questionPrompt: css({ color: "var(--coffee-text)", fontSize: "sm", fontWeight: "medium", lineHeight: "1.5", textWrap: "pretty" }),
   questionOptionGrid: css({ display: "grid", gridTemplateColumns: { base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: "2" }),
   questionOption: css({ minH: "11", h: "auto", justifyContent: "space-between", gap: "3", px: "3", py: "2.5", textAlign: "left", whiteSpace: "normal", lineHeight: "1.35" }),
   questionOptionCopy: css({ minW: "0", display: "flex", flexDir: "column", alignItems: "flex-start", gap: "0.5" }),
   questionOptionDescription: css({ color: "var(--coffee-text-muted)", fontSize: "xs", fontWeight: "normal" }),
   questionAnswerInput: css({ mt: "1" }),
   questionSubmitRow: css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "3", pt: "1" }),
  nativeInput: css({ w: "full", minH: "10", px: "3", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "lg", bg: "var(--coffee-canvas)", color: "var(--coffee-text)", outline: "none", _focusVisible: { borderColor: "var(--coffee-accent)", boxShadow: "0 0 0 2px var(--coffee-glow)" }, _placeholder: { color: "var(--coffee-text-muted)" } }),
  formRow: css({ display: "flex", alignItems: "center", gap: "2" }),
  attachmentInput: css({ position: "absolute", w: "1px", h: "1px", p: "0", m: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: "0" }),
  attachmentButton: css({ minW: "11", h: "11", flexShrink: "0", display: "grid", placeItems: "center", borderRadius: "lg", color: "var(--coffee-text-muted)", cursor: "pointer", _hover: { color: "var(--coffee-text)", bg: "var(--coffee-surface-raised)" }, _focusWithin: { outline: "2px solid var(--coffee-accent)", outlineOffset: "2px" } }),
  chipList: css({ display: "flex", flexWrap: "wrap", gap: "2", px: "3", pt: "2" }),
  chip: css({ display: "inline-flex", alignItems: "center", gap: "1", maxW: "240px", px: "2", py: "1", borderRadius: "md", bg: "var(--coffee-surface-raised)", border: "1px solid", borderColor: "var(--coffee-border)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  chipName: css({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
  chipDelete: css({ minW: "8", minH: "8", display: "grid", placeItems: "center", borderRadius: "sm", color: "var(--coffee-text-muted)", _hover: { color: "var(--coffee-danger-text)", bg: "var(--coffee-surface)" }, _focusVisible: { outline: "2px solid var(--coffee-accent)", outlineOffset: "2px" } }),
  streamCard: css({ alignSelf: "flex-start", w: "full", maxW: "full", mt: "4", pt: "4", pb: "3", borderTop: "1px solid", borderColor: "var(--coffee-border)", bg: "transparent" }),
  streamHeader: css({ display: "flex", alignItems: "center", gap: "2", mb: "3", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  streamPulse: css({ w: "2", h: "2", borderRadius: "full", bg: "var(--coffee-accent-strong)", animation: "pulse 1.4s ease-in-out infinite" }),
  executionState: css({ display: "flex", flexDir: "column", gap: "3", py: "1" }),
  executionCopy: css({ color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.6" }),
  executionTrack: css({ display: "flex", flexDir: "column", gap: "2", w: "min(420px, 80%)" }),
  executionLine: css({ h: "2", borderRadius: "full", bg: "linear-gradient(90deg, var(--coffee-border) 25%, var(--coffee-surface-raised) 50%, var(--coffee-border) 75%)", backgroundSize: "200% 100%", animation: "loading-shimmer 1.3s ease-in-out infinite" }),
  executionLineShort: css({ w: "62%" }),
  reasoningPanel: css({ mb: "3", color: "var(--coffee-text-muted)", fontSize: "sm", borderBottom: "1px solid", borderColor: "var(--coffee-border)", pb: "3" }),
  reasoningSummary: css({ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)" }),
  historyPanel: css({ mt: "3", pt: "2", borderTop: "1px solid", borderColor: "var(--coffee-border)", color: "var(--coffee-text-muted)", fontSize: "sm" }),
  historySummary: css({ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "xs", color: "var(--coffee-text-muted)" }),
  historyList: css({ display: "flex", flexDir: "column", gap: "1", mt: "2", pl: "3", borderLeft: "2px solid", borderColor: "var(--coffee-border-strong)", fontFamily: "var(--font-mono)", fontSize: "xs", lineHeight: "1.5" }),
  streamBody: css({ lineHeight: "1.7" }),
  latestButton: css({ position: "absolute", zIndex: "5", right: { base: "5", md: "11" }, bottom: "4", border: "1px solid", borderColor: "var(--coffee-border-strong)", bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)", boxShadow: "0 8px 20px var(--coffee-shadow)" }),
  messageBoundary: css({ display: "block" }),
  messageContinuation: css({}),
  messageHiddenMeta: css({ display: "none" }),
  messageCodeWrap: css({ position: "relative", mb: "3", borderRadius: "lg", overflow: "hidden", bg: "var(--coffee-canvas)" }),
  messageCodeToolbar: css({ display: "flex", justifyContent: "space-between", alignItems: "center", px: "3", py: "2", borderBottom: "1px solid", borderColor: "var(--coffee-border)", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }),
  messageCodeCopy: css({ minH: "8", px: "2", borderRadius: "sm", color: "var(--coffee-accent-strong)", _hover: { bg: "var(--coffee-surface-raised)" } }),
  messageCode: css({ maxW: "full", overflowX: "auto", m: "0", p: "3", fontFamily: "var(--font-mono)", fontSize: "sm", lineHeight: "1.55", whiteSpace: "pre" }),
  messageInlineCode: css({ px: "1", borderRadius: "sm", bg: "var(--coffee-surface-raised)", fontFamily: "var(--font-mono)", fontSize: "0.92em" }),
  messageMarkdown: css({ overflowWrap: "anywhere", whiteSpace: "normal", "& p": { m: "0 0 3", textAlign: "left", _last: { m: "0" } }, "& h4": { m: "0 0 3", fontSize: "md", fontWeight: "semibold" }, "& ul": { m: "0 0 3", pl: "5", _last: { m: "0" } }, "& ol": { m: "0 0 3", pl: "5", _last: { m: "0" } }, "& a": { color: "var(--coffee-accent-strong)", textDecoration: "underline", textUnderlineOffset: "3px" } }),
  messageActions: css({ position: "static", zIndex: "0", flexShrink: "0", w: "full", mt: "0", px: "4", pt: "1", pb: "2", display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "1", opacity: "0", transition: "opacity 160ms ease" }),
  messageAction: css({ minH: "9", px: "2", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", _hover: { color: "var(--coffee-text)", bg: "var(--coffee-surface-raised)" } }),
  activityLog: css({ w: "full", maxW: "920px", mx: "auto", px: { base: "4", md: "10" }, py: "1", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px" }),
  olderMessages: css({ display: "flex", justifyContent: "center", alignItems: "center", minH: "10", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs" }),
  controlSection: css({ display: "flex", flexDir: "column", gap: "3", mb: "5" }),
  settingsBody: css({ display: "flex", flexDir: "column", gap: "6" }),
  settingsLayout: css({ minH: "0", display: "grid", gridTemplateColumns: { base: "1fr", md: "176px minmax(0, 1fr)" }, gap: { base: "4", md: "7" } }),
   settingsNav: css({ minW: "0", display: "flex", flexDir: { base: "row", md: "column" }, alignItems: "stretch", gap: "1", overflowX: "auto", borderRight: { base: "0", md: "1px solid" }, borderBottom: { base: "1px solid", md: "0" }, borderColor: "var(--coffee-border)", pb: { base: "2", md: "0" }, pr: { base: "0", md: "5" }, position: { base: "sticky", md: "static" }, top: "0", zIndex: "1", bg: "var(--coffee-surface-raised)" }),
  settingsNavEyebrow: css({ display: { base: "none", md: "block" }, px: "3", pb: "3", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase" }),
   settingsNavButton: css({ position: "relative", w: { base: "auto", md: "full" }, flex: { base: "1", md: "none" }, minH: "12", flexShrink: "0", justifyContent: "flex-start", gap: "2", px: "3", borderRadius: "lg", color: "var(--coffee-text-muted)", _hover: { bg: "var(--coffee-surface)", color: "var(--coffee-text)" }, _focusVisible: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "2px" } }),
   settingsNavButtonActive: css({ bg: "var(--coffee-glow)", border: "1px solid", borderColor: "var(--coffee-accent-strong)", color: "var(--coffee-text)", fontWeight: "semibold" }),
   settingsNavIcon: css({ display: "grid", placeItems: "center", w: "7", h: "7", flexShrink: "0", borderRadius: "md", color: "var(--coffee-text-muted)", background: "var(--coffee-canvas)" }),
   settingsNavIconActive: css({ color: "var(--coffee-on-accent)", background: "var(--coffee-accent-strong)" }),
  settingsNavCopy: css({ display: "flex", flexDir: "column", alignItems: "flex-start", gap: "0.5", whiteSpace: "nowrap" }),
  settingsNavDetail: css({ color: "var(--coffee-text-muted)", fontSize: "10px", fontWeight: "normal" }),
  settingsPanel: css({ minW: "0", maxH: "min(600px, calc(100dvh - 180px))", overflowY: "auto", pr: { base: "0", md: "2" } }),
  settingsSection: css({ display: "flex", flexDir: "column", gap: "5", pb: "2" }),
  settingsSectionHeader: css({ display: "flex", flexDir: "column", gap: "1.5", pb: "1" }),
  settingsSectionTitle: css({ color: "var(--coffee-text)", fontSize: "xl", fontWeight: "semibold", letterSpacing: "-0.02em" }),
  settingsSectionDescription: css({ maxW: "52ch", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.55" }),
  controlHeader: css({ display: "flex", flexDir: "column", gap: "1" }),
  controlTitle: css({ color: "var(--coffee-text)", fontSize: "sm", fontWeight: "semibold" }),
  controlHint: css({ color: "var(--coffee-text-muted)", fontSize: "xs", lineHeight: "1.5" }),
   settingsGroup: css({ display: "flex", flexDir: "column", gap: "3", p: { base: "3", md: "4" }, border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "xl", bg: "var(--coffee-canvas)" }),
  settingsField: css({ display: "flex", flexDir: "column", gap: "3", p: "3" }),
  settingsTextArea: css({ w: "full", minH: "20", resize: "vertical", p: "3", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "lg", bg: "var(--coffee-canvas)", color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: "xs", lineHeight: "1.55", outline: "none", _focusVisible: { borderColor: "var(--coffee-accent)", boxShadow: "0 0 0 2px var(--coffee-glow)" }, _placeholder: { color: "var(--coffee-text-muted)" } }),
  widthOptions: css({ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "1", p: "1", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "xl", bg: "var(--coffee-canvas)" }),
  widthOption: css({ minW: "0", minH: "17", display: "flex", flexDir: "column", alignItems: "stretch", justifyContent: "space-between", gap: "2", px: "2", py: "2", borderRadius: "lg", color: "var(--coffee-text-muted)", _hover: { bg: "var(--coffee-surface)", color: "var(--coffee-text)" } }),
   widthOptionActive: css({ bg: "var(--coffee-glow)", color: "var(--coffee-accent-strong)", border: "1px solid", borderColor: "var(--coffee-accent-strong)" }),
  widthOptionLabel: css({ fontSize: "xs", fontWeight: "semibold" }),
  widthOptionPreview: css({ display: "flex", alignItems: "center", justifyContent: "center", h: "3", w: "full", borderRadius: "sm", bg: "var(--coffee-border)", _before: { content: '""', display: "block", h: "1", borderRadius: "full", bg: "var(--coffee-text-muted)", w: "80%" } }),
  settingRow: css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "5", minH: "17", px: "3", py: "3", borderTop: "1px solid", borderColor: "var(--coffee-border)", _first: { borderTop: "0" } }),
  settingCopy: css({ minW: "0", display: "flex", flexDir: "column", gap: "1" }),
  settingTitle: css({ color: "var(--coffee-text)", fontSize: "sm", fontWeight: "semibold" }),
   settingDescription: css({ color: "var(--coffee-text-muted)", fontSize: "xs", lineHeight: "1.5" }),
   mediaDirectoryList: css({ display: "flex", flexDir: "column", gap: "1" }),
   mediaDirectoryChip: css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "2", minW: "0", px: "3", py: "1.5", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-canvas)", color: "var(--coffee-text)", fontFamily: "var(--font-mono)", fontSize: "xs", overflowWrap: "anywhere" }),
   mediaDirectoryPicker: css({ display: "flex", alignItems: "flex-end", gap: "2", minW: "0", "& > *:first-child": { flex: "1", minW: "0" }, color: "var(--coffee-accent-strong)" }),
   mediaDirectoryInputRow: css({ display: "flex", alignItems: "center", gap: "2", minW: "0", "& > input": { flex: "1", minW: "0" } }),
  toggle: css({ position: "relative", flexShrink: "0", display: "inline-flex", alignItems: "center", w: "11", h: "6", borderRadius: "full", cursor: "pointer", _focusWithin: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "2px" } }),
  toggleInput: css({ position: "absolute", w: "1px", h: "1px", opacity: "0", pointerEvents: "none" }),
  toggleTrack: css({ display: "flex", alignItems: "center", w: "full", h: "full", p: "1", borderRadius: "full", bg: "var(--coffee-border-strong)", transition: "background 160ms ease" }),
  toggleTrackChecked: css({ bg: "var(--coffee-accent)" }),
  toggleThumb: css({ display: "block", w: "4", h: "4", borderRadius: "full", bg: "var(--coffee-surface)", boxShadow: "0 1px 3px var(--coffee-shadow)", transition: "transform 160ms ease" }),
  toggleThumbChecked: css({ transform: "translateX(20px)" }),
   settingsSaveHint: css({ display: "flex", alignItems: "center", gap: "2", color: "var(--coffee-text-muted)", fontSize: "xs" }),
   settingsFooter: css({ position: "sticky", bottom: "0", zIndex: "1", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "3", mt: "2", pt: "4", pb: "1", borderTop: "1px solid", borderColor: "var(--coffee-border)", bg: "var(--coffee-surface-raised)" }),
   settingsFooterActions: css({ display: "flex", alignItems: "center", gap: "2", flexShrink: "0" }),
  authShell: css({ minH: "100dvh", display: "grid", placeItems: "center", position: "relative", overflow: "hidden", p: { base: "4", md: "8" }, bg: "var(--coffee-canvas)", color: "var(--coffee-text)", _before: { content: '""', position: "absolute", inset: "0", pointerEvents: "none", opacity: "0.45", background: "radial-gradient(circle at 14% 16%, var(--coffee-glow), transparent 30%), radial-gradient(circle at 88% 82%, rgba(224, 160, 100, .08), transparent 28%)" } }),
  authThemeActions: css({ position: "absolute", top: { base: "3", md: "6" }, right: { base: "3", md: "8" }, zIndex: "2", display: "flex", gap: "1", p: "1", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-surface)" }),
  authThemeToggle: css({ position: "absolute", top: { base: "3", md: "6" }, right: { base: "3", md: "8" }, zIndex: "2", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-surface)", _hover: { bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-border-strong)" } }),
  authLayout: css({ position: "relative", zIndex: "1", w: "full", maxW: "1040px", display: "grid", gridTemplateColumns: { base: "1fr", md: "minmax(0, 1.05fr) minmax(360px, .95fr)" }, alignItems: "stretch", border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "3xl", overflow: "hidden", bg: "var(--coffee-surface)", boxShadow: "0 30px 90px var(--coffee-shadow)" }),
  authAside: css({ minH: { base: "auto", md: "480px" }, p: { base: "7", md: "12" }, display: "flex", flexDir: "column", justifyContent: "space-between", gap: "10", borderRight: { base: "0", md: "1px solid" }, borderBottom: { base: "1px solid", md: "0" }, borderColor: "var(--coffee-border)", background: "linear-gradient(145deg, var(--coffee-sidebar), var(--coffee-surface))" }),
  authBrand: css({ display: "flex", alignItems: "center", gap: "3", fontWeight: "semibold", letterSpacing: "-0.02em" }),
  authMark: css({ display: "grid", placeItems: "center", w: "10", h: "10", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "lg", bg: "var(--coffee-surface-raised)", color: "var(--coffee-accent-strong)", boxShadow: "0 0 0 6px var(--coffee-glow)" }),
  authEyebrow: css({ mb: "4", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase" }),
  authAsideLead: css({ mt: "clamp(3rem, 10vh, 7rem)" }),
  authHeadline: css({ maxW: "12ch", fontSize: { base: "2xl", md: "4xl" }, fontWeight: "semibold", letterSpacing: "-0.045em", lineHeight: "1.05", textWrap: "balance" }),
  authAsideCopy: css({ maxW: "38ch", mt: "5", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.7" }),
  authSignal: css({ display: "flex", alignItems: "center", gap: "2", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.04em" }),
  authSignalDot: css({ w: "2", h: "2", borderRadius: "full", bg: "var(--coffee-status)", boxShadow: "0 0 0 4px var(--coffee-glow)" }),
  authCard: css({ w: "full", maxW: "480px", justifySelf: "center", p: { base: "7", md: "12" }, display: "flex", flexDir: "column", gap: "7", bg: "var(--coffee-surface)" }),
  authPanelHeader: css({ display: "flex", flexDir: "column", gap: "2" }),
  authTitle: css({ fontSize: "2xl", fontWeight: "semibold", letterSpacing: "-0.035em" }),
  authCopy: css({ color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.6" }),
  authForm: css({ display: "flex", flexDir: "column", gap: "4" }),
  authField: css({ display: "flex", flexDir: "column", gap: "2" }),
  authSubmit: css({ w: "full", mt: "2" }),
  authNote: css({ color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "1.6" }),
  authError: css({ color: "var(--coffee-danger-text)", fontSize: "sm" }),
}

const themeColors = {
  cosmic: { light: "#eef3ff", dark: "#080d1c" },
  amethyst: { light: "#f2edff", dark: "#171126" },
  meadow: { light: "#edf6e8", dark: "#10251c" },
  komorebi: { light: "#f2ead2", dark: "#17231d" },
  coffee: { light: "#f3e3cd", dark: "#100805" },
  tokyo: { light: "#e6e7ed", dark: "#1a1b26" },
  spring: { light: "#fff4f7", dark: "#211b2b" },
  summer: { light: "#fff8df", dark: "#0c1f2b" },
  autumn: { light: "#f5ead6", dark: "#241812" },
  winter: { light: "#f3f8fc", dark: "#101b2a" },
  monochrome: { light: "#f2f2f2", dark: "#171717" },
  paper: { light: "#f4efe4", dark: "#29231c" },
} satisfies Readonly<Record<ThemeFamily, { readonly light: string; readonly dark: string }>>

const pickerCopy = {
  quickOpen: { breadcrumb: "Switch session", title: "Switch session", description: "Search sessions in the current project." },
  project: { breadcrumb: "Switch project", title: "Choose a workspace", description: "Choose a folder from the configured projects root. Existing OpenCode projects are marked." },
  model: { breadcrumb: "Choose model", title: "Choose a model", description: "Choose a provider, model, and variant." },
  agent: { breadcrumb: "Choose agent", title: "Choose an agent", description: "Choose the agent for new prompts." },
  control: { breadcrumb: "Session actions", title: "Session actions", description: "Manage the current session." },
  theme: { breadcrumb: "Theme", title: "Theme", description: "Choose light or dark mode, then select a palette." },
  settings: { breadcrumb: "Settings", title: "Settings", description: "Manage appearance and workspace preferences." },
  command: { breadcrumb: "Command palette", title: "Command palette", description: "Choose an action. Use the arrow keys, then press Enter." },
} satisfies Readonly<Record<AppState["pickerMode"], { readonly breadcrumb: string; readonly title: string; readonly description: string }>>

export default function App() {
  const effectRunner = makeAppEffectRunner()
  const run = effectRunner.run
  const state = useAtomValue(appStateAtom)
  const viewModel = createAppViewModel(useAtomRegistry(), effectRunner)
  const sessions = () => state().sessions
  const subagents = () => state().subagents
  const directory = () => state().directory
  const projects = () => state().projects
  const models = () => state().models
  const modelProviderKey = () => state().modelProviderKey
  const modelKey = () => state().modelKey
  const selectedModel = () => models().find((model) => `${model.providerID}/${model.id}` === modelKey())
  const variantKey = () => state().variantKey
  const agents = () => state().agents
  const agentKey = () => state().agentKey
  const availableAgents = () => agents().filter((agent) => agent.hidden !== true && agent.mode !== "subagent")
  const selectedAgent = () => availableAgents().find((agent) => agent.id === agentKey()) ?? (agentKey().length === 0 ? availableAgents().find((agent) => agent.id === "build") : undefined)
  const agentPickerOpen = () => state().agentPickerOpen
  const selectedID = () => state().selectedID
  const sessionPermissions = () => selectedID() === undefined ? [] : state().permissions.filter((permission) => permission.sessionID === selectedID())
  const sessionQuestions = () => selectedID() === undefined ? [] : state().questions.filter((question) => question.sessionID === selectedID())
  const messages = () => state().messages
  const text = () => state().text
  const busy = () => state().busy
  const attachments = () => state().attachments
  const queuedPrompts = () => state().queuedPrompts.filter((prompt) => prompt.sessionID === selectedID())
  const connection = () => state().connection
  const theme = () => state().theme
  const themeFamily = () => state().themeFamily
  const [sidebarOpen, setSidebarOpen] = createSignal(true)
  const [isMobile, setIsMobile] = createSignal(false)
  const [stickToBottom, setStickToBottom] = createSignal(true)
  const [latestAvailable, setLatestAvailable] = createSignal(false)
  const [settingsDirty, setSettingsDirty] = createSignal(false)
  const [settingsDiscardOpen, setSettingsDiscardOpen] = createSignal(false)
  const [settingsThemeBase, setSettingsThemeBase] = createSignal<"light" | "dark">("dark")
  const [settingsFamilyBase, setSettingsFamilyBase] = createSignal<ThemeFamily>("coffee")
  const [authReady, setAuthReady] = createSignal(false)
  const [authenticated, setAuthenticated] = createSignal(false)
  const [loginUsername, setLoginUsername] = createSignal("")
  const [loginPassword, setLoginPassword] = createSignal("")
   const [loginBusy, setLoginBusy] = createSignal(false)
   const [loginError, setLoginError] = createSignal("")
  const [pendingExpanded, setPendingExpanded] = createSignal(false)
  const [queueDialogOpen, setQueueDialogOpen] = createSignal(false)
  const [commandQuery, setCommandQuery] = createSignal("")
  const [commandActiveIndex, setCommandActiveIndex] = createSignal(0)
  const [pickerFromCommand, setPickerFromCommand] = createSignal(false)
  const [activityLog, setActivityLog] = createSignal<readonly { readonly label: string; readonly time: string }[]>([])
  const [copiedMessage, setCopiedMessage] = createSignal<string>()
  let copyResetFiber: Fiber.Fiber<void> | undefined
  let copyGeneration = 0
  let cleanupViewModel: (() => void) | undefined
  let workspaceStarted = false
  let conversationElement: HTMLElement | undefined
  let commandInputElement: HTMLInputElement | undefined
  let autoScrollFrame: number | undefined
  let autoScrollPasses = 0
  let autoScrollInProgress = false
  let lastConversationMessageCount = 0
  let lastConversationFirstMessageKey: string | undefined
  let lastConversationScrollHeight = 0
  let lastConversationScrollTop = 0
  let revealLatestOnNextMessages = true

  createEffect(() => {
    const activity = state().activity
    if (activity === undefined) return
    setActivityLog((items) => items.at(-1)?.label === activity ? items : [...items.slice(-4), { label: activity, time: new Date().toISOString() }])
  })

  createEffect(() => {
    const currentMessages = messages()
    const count = currentMessages.length
    if (count === lastConversationMessageCount) return
    const firstMessage = currentMessages[0]
    const firstMessageKey = firstMessage?.id ?? (firstMessage === undefined ? undefined : `${firstMessage.role}:${firstMessage.text}`)
    const insertedAbove = lastConversationFirstMessageKey !== undefined && firstMessageKey !== lastConversationFirstMessageKey && count > lastConversationMessageCount
    const previousHeight = lastConversationScrollHeight
    const previousTop = lastConversationScrollTop
    lastConversationMessageCount = count
    lastConversationFirstMessageKey = firstMessageKey
    queueMicrotask(() => {
      if (conversationElement === undefined) return
      if (count > 0 && revealLatestOnNextMessages) {
        revealLatestOnNextMessages = false
        setLatestAvailable(false)
        scrollConversationToBottom()
      } else if (stickToBottom()) {
        scrollConversationToBottom()
      } else if (insertedAbove && previousHeight > 0) {
        // Keep the same message under the user's eyes when older messages are
        // inserted above the current viewport.
        const heightDelta = conversationElement.scrollHeight - previousHeight
        if (heightDelta !== 0) conversationElement.scrollTo({ top: previousTop + heightDelta, behavior: "auto" })
      }
      const distanceFromBottom = conversationElement.scrollHeight - conversationElement.scrollTop - conversationElement.clientHeight
      setLatestAvailable(distanceFromBottom >= 24)
      lastConversationScrollHeight = conversationElement.scrollHeight
      lastConversationScrollTop = conversationElement.scrollTop
    })
  })
  createEffect(() => {
    const streamedText = state().streamedText
    const reasoning = state().reasoning
    const activityHistory = state().activityHistory
    if (!(busy() || streamedText.length > 0 || reasoning.length > 0 || activityHistory.length > 0)) return
    if (stickToBottom()) queueMicrotask(scrollConversationToBottom)
    else setLatestAvailable(true)
  })
  createEffect(() => {
    selectedID()
    setStickToBottom(true)
    setLatestAvailable(false)
    setQueueDialogOpen(false)
    revealLatestOnNextMessages = true
    lastConversationMessageCount = -1
    lastConversationFirstMessageKey = undefined
    lastConversationScrollHeight = 0
    lastConversationScrollTop = 0
    setActivityLog([])
  })
  createEffect(() => {
    const currentTheme = theme()
    const currentThemeFamily = themeFamily()
    document.documentElement.dataset.theme = currentTheme
    document.documentElement.dataset.palette = currentThemeFamily
    document.documentElement.classList.toggle("dark", currentTheme === "dark")
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[currentThemeFamily][currentTheme])
  })
  createEffect(() => {
    const sidebar = state().userSettings.sidebar
    if (!isMobile() && (sidebar === "open" || sidebar === "closed")) setSidebarOpen(sidebar === "open")
  })
  createEffect(() => {
    if (state().pickerMode === "command") queueMicrotask(() => commandInputElement?.focus())
  })
  const scrollConversationToBottom = () => {
    if (conversationElement === undefined) return
    if (autoScrollFrame !== undefined) {
      window.cancelAnimationFrame(autoScrollFrame)
      autoScrollFrame = undefined
    }
    autoScrollInProgress = true
    setLatestAvailable(false)
    autoScrollPasses = 0
    let stablePasses = 0
    let previousHeight = -1
    const scroll = () => {
      const element = conversationElement
      if (element === undefined) {
        autoScrollInProgress = false
        autoScrollFrame = undefined
        return
      }
      const height = element.scrollHeight
      element.scrollTop = height
      autoScrollPasses += 1
      if (height === previousHeight && element.scrollHeight - element.scrollTop - element.clientHeight <= 1) stablePasses += 1
      else stablePasses = 0
      previousHeight = height
      if (autoScrollPasses < 12 && stablePasses < 2) {
        autoScrollFrame = window.requestAnimationFrame(scroll)
        return
      }
      autoScrollInProgress = false
      autoScrollFrame = undefined
    }
    autoScrollFrame = window.requestAnimationFrame(scroll)
  }
  const handleConversationScroll = () => {
    if (conversationElement === undefined || autoScrollInProgress) return
    const distanceFromBottom = conversationElement.scrollHeight - conversationElement.scrollTop - conversationElement.clientHeight
    setStickToBottom(distanceFromBottom < 96)
    setLatestAvailable(distanceFromBottom >= 96)
    lastConversationScrollHeight = conversationElement.scrollHeight
    lastConversationScrollTop = conversationElement.scrollTop
    if (conversationElement.scrollTop < 120 && state().hasOlderMessages && !state().loading.loadingOlderMessages) viewModel.loadOlderMessages()
  }
  const syncConversationPosition = () => {
    const element = conversationElement
    if (element === undefined) return
    const update = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
      setStickToBottom(distanceFromBottom < 96)
      setLatestAvailable(distanceFromBottom >= 96)
    }
    update()
    requestAnimationFrame(update)
  }
  const jumpToLatest = () => {
    setStickToBottom(true)
    setLatestAvailable(false)
    const sessionID = selectedID()
    if (sessionID !== undefined) viewModel.loadMessages(sessionID)
    scrollConversationToBottom()
  }
  const startWorkspace = () => {
    if (workspaceStarted) return
    workspaceStarted = true
    cleanupViewModel = viewModel.mount()
  }
  const submitLogin = (event: SubmitEvent) => {
    event.preventDefault()
    setLoginBusy(true)
    setLoginError("")
    run(loginWeb(loginUsername(), loginPassword()),
      (error) => {
        setLoginError(error.message)
        setLoginBusy(false)
      },
      () => {
      setAuthenticated(true)
      setLoginPassword("")
      setLoginBusy(false)
      startWorkspace()
      },
    )
  }
  const updateText = (event: InputEvent) => {
    if (event.currentTarget instanceof HTMLTextAreaElement) viewModel.setText(event.currentTarget.value)
  }

  const openPicker = (mode: "quickOpen" | "command" | "project" | "model" | "agent" | "control" | "theme" | "settings") => {
    if (isMobile()) setSidebarOpen(false)
    if (mode === "settings") {
      setSettingsThemeBase(theme())
      setSettingsFamilyBase(themeFamily())
      setSettingsDirty(false)
      viewModel.loadObservability()
    }
    if (mode === "command") {
      setCommandQuery("")
      setCommandActiveIndex(0)
      setPickerFromCommand(false)
    } else {
      setPickerFromCommand(false)
    }
    viewModel.openPicker(mode)
  }
  const openCommandFollowUp = (mode: "quickOpen" | "project" | "model" | "agent" | "control" | "theme" | "settings") => {
    setPickerFromCommand(true)
    viewModel.openPicker(mode)
  }
  const pickerBack = () => {
    if (state().pickerMode === "settings" && settingsDirty()) {
      setSettingsDiscardOpen(true)
      return
    }
    if (pickerFromCommand()) openPicker("command")
    else closePicker()
  }
  const setSidebar = (open: boolean) => {
    setSidebarOpen(open)
    viewModel.setUserSetting("sidebar", open ? "open" : "closed")
  }
  const selectSession = (sessionID: string) => {
    viewModel.selectSession(sessionID)
    if (isMobile()) setSidebarOpen(false)
  }
  const selectSessionFromPicker = (sessionID: string) => {
    if (sessionID.length > 0) { viewModel.selectSession(sessionID); viewModel.closePicker() }
  }
  const selectAgent = (agent: string) => viewModel.selectAgent(agent)
  const selectModelProvider = (provider: string) => viewModel.selectModelProvider(provider)
  const selectModel = (key: string) => viewModel.selectModel(key)
   const selectProject = (selectedDirectory: string) => viewModel.selectProject(selectedDirectory)
  const selectVariant = (variant: string) => viewModel.selectVariant(variant)
  const createSession = () => viewModel.createSession()
  const submit = (event: SubmitEvent) => { event.preventDefault(); viewModel.submit() }
  const chooseAttachments = (event: Event) => {
    if (event.currentTarget instanceof HTMLInputElement && event.currentTarget.files !== null) {
      viewModel.addAttachments(event.currentTarget.files)
      event.currentTarget.value = ""
    }
  }
  const toggleQuestionOption = (requestID: string, questionIndex: number, label: string, multiple: boolean) => {
    const current = state().questionDrafts[requestID]?.[questionIndex] ?? []
    let answers = [label]
    if (multiple) answers = current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
    viewModel.setQuestionAnswer(requestID, questionIndex, answers)
  }
  const sessionLabel = (session: Session): string => session.title !== undefined && !/^ses_[A-Za-z0-9]+$/.test(session.title) ? session.title : "Untitled session"
  const projectLabel = (name: string, directory: string): string => name !== directory ? name : directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory
   const projectOptions = () => projects().map((project) => ({
     label: projectLabel(project.name, project.directory),
     value: project.directory,
     detail: project.directory,
     group: project.opencodeProject === undefined ? "New OpenCode project" : "Available in OpenCode",
     status: project.opencodeProject === undefined ? "Creates when you start the first session" : "OpenCode project",
   }))
  const chatWidth = () => state().userSettings.chatWidth === "full" || state().userSettings.chatWidth === "wide" || state().userSettings.chatWidth === "narrow" ? state().userSettings.chatWidth : "normal"
   const chatWidthClass = (): string => {
     if (chatWidth() === "full") return styles.chatWidthFull
     if (chatWidth() === "wide") return styles.chatWidthWide
     if (chatWidth() === "narrow") return styles.chatWidthNarrow
     return styles.chatWidthNormal
   }
  const providerOptions = () => [...new Set(models().map((model) => model.providerID))]
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => ({ label: provider, value: provider, detail: `${models().filter((model) => model.providerID === provider).length} models` }))
  const modelOptions = () => models()
    .filter((model) => model.providerID === modelProviderKey())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((model) => ({ label: model.name, value: `${model.providerID}/${model.id}`, detail: model.providerID }))
  const agentOptions = () => availableAgents()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((agent) => ({ label: agent.name, value: agent.id, detail: agent.description }))
  const modelValueForProvider = () => selectedModel()?.providerID === modelProviderKey() ? modelKey() : ""
  const providerSelectedModel = () => selectedModel()?.providerID === modelProviderKey() ? selectedModel() : undefined
  const defaultVariantValue = "__default__"
  const variantOptions = () => [{ label: "Default", value: defaultVariantValue, detail: "Use the provider default" }, ...(providerSelectedModel()?.variants ?? []).map((variant) => ({ label: variant.id, value: variant.id, detail: "Model response style" }))]
  const unavailableModel = () => modelKey().length > 0 && selectedModel() === undefined
  const hideSubagents = () => state().userSettings.hideSubagents === "true"
  const visibleSessions = () => hideSubagents() ? sessions().filter((session) => session.parentID === undefined) : sessions()
  const visibleSessionOptions = () => visibleSessions().map((session) => ({ label: sessionLabel(session), value: session.id, detail: session.id }))
   const orderedSessions = () => [...visibleSessions()].sort((left, right) => Number(state().favoriteSessionIDs.includes(right.id)) - Number(state().favoriteSessionIDs.includes(left.id)))
   const sessionIDLabel = (sessionID: string): string => sessionID.length > 14 ? `…${sessionID.slice(-12)}` : sessionID
   const sessionProjectLabel = (session: Session): string => session.projectName ?? projectLabel(directory(), session.projectDirectory ?? directory())
  const topSessions = () => orderedSessions().slice(0, 5)
  const pinnedSessions = () => topSessions().filter((session) => state().favoriteSessionIDs.includes(session.id))
  const recentSessions = () => topSessions().filter((session) => !state().favoriteSessionIDs.includes(session.id))
  const allPinnedSessions = () => orderedSessions().filter((session) => state().favoriteSessionIDs.includes(session.id))
  const allRecentSessions = () => orderedSessions().filter((session) => !state().favoriteSessionIDs.includes(session.id))
  const [sessionBrowserOpen, setSessionBrowserOpen] = createSignal(false)
  const sessionRow = (session: Session) => {
    const favorite = () => state().favoriteSessionIDs.includes(session.id)
    const active = () => state().activeSessionIDs.includes(session.id)
    const selectedClass = (): string => {
      if (session.id !== selectedID()) return ""
      return isLight() ? styles.lightActiveSession : styles.activeSession
    }
    return <div class={styles.sessionRow}>
      <Button class={`${styles.sessionMain} ${isLight() ? styles.lightSession : ""} ${selectedClass()}`} variant="ghost" onClick={() => { selectSession(session.id); setSessionBrowserOpen(false) }}>
         <span class={styles.sessionIconWrap}><MessageSquare size={15} /></span>
        <span class={styles.sessionCopy}>
           <span class={styles.sessionTitleRow}><span class={styles.sessionTitle}>{sessionLabel(session)}</span><Show when={active()}><span class={styles.activeSessionPulse} title="Running" aria-hidden="true" /></Show></span>
           <span class={styles.sessionDetail} title={session.id}>{sessionProjectLabel(session)} · {sessionIDLabel(session.id)}</span>
          <Show when={active()}><span class={styles.srOnly}>Running</span></Show>
        </span>
      </Button>
      <Button class={`${styles.favoriteButton} ${favorite() ? styles.favoriteButtonActive : ""}`} variant="ghost" size="sm" aria-label={favorite() ? `Unpin ${sessionLabel(session)}` : `Pin ${sessionLabel(session)}`} aria-pressed={favorite()} title={favorite() ? "Unpin session" : "Pin session"} onClick={() => viewModel.toggleFavoriteSession(session.id)}>
        <Star size={15} fill={favorite() ? "currentColor" : "none"} />
       </Button>
     </div>
   }
   const [pinnedSessionsOpen, setPinnedSessionsOpen] = createSignal(true)
   const [recentSessionsOpen, setRecentSessionsOpen] = createSignal(true)
  const commandMatches = (label: string, detail: string): boolean => {
    const query = commandQuery().trim().toLocaleLowerCase()
    return query.length === 0 || `${label} ${detail}`.toLocaleLowerCase().includes(query)
  }
  const commandEntries = () => [
     { id: "project", label: "Switch project", detail: "Choose a workspace", disabled: state().loading.projects },
     { id: "session", label: "Switch session", detail: "Open a conversation in this project", disabled: sessions().length === 0 },
     { id: "model", label: "Switch model", detail: "Choose a model and variant", disabled: selectedID() === undefined || state().loading.models },
     { id: "compact", label: "Compact session", detail: "Reduce the current session context", disabled: selectedID() === undefined || busy() },
    { id: "review", label: "Review changes", detail: "Queue a focused review", disabled: selectedID() === undefined },
    { id: "new", label: "New session", detail: "Start a fresh conversation", disabled: directory().length === 0 || state().loading.creatingSession },
     { id: "theme", label: "Theme", detail: "Choose mode, palette, or season", disabled: false },
     { id: "settings", label: "Open settings", detail: "Manage workspace preferences", disabled: false },
  ].filter((entry) => commandMatches(entry.label, entry.detail))
  createEffect(() => {
    const entries = commandEntries()
    const current = entries[commandActiveIndex()]
    if (entries.length === 0) return
    if (current === undefined || current.disabled) {
      const firstEnabled = entries.findIndex((entry) => !entry.disabled)
      setCommandActiveIndex(firstEnabled >= 0 ? firstEnabled : 0)
    }
  })
  const executeCommand = (id: string) => {
    if (id === "project") openCommandFollowUp("project")
    else if (id === "session") openCommandFollowUp("quickOpen")
    else if (id === "model") openCommandFollowUp("model")
    else if (id === "compact" || id === "review") openCommandFollowUp("control")
    else if (id === "new") runCommand(createSession)
    else if (id === "theme") openCommandFollowUp("theme")
    else if (id === "settings") openCommandFollowUp("settings")
  }
  const runCommand = (action: () => void) => {
    viewModel.closePicker()
    action()
  }
  const closePicker = () => {
    if (state().pickerMode === "settings") {
      viewModel.setTheme(settingsThemeBase())
      viewModel.setThemeFamily(settingsFamilyBase())
    }
    setSettingsDirty(false)
    setSettingsDiscardOpen(false)
    if (pickerFromCommand() && state().pickerMode !== "command") queueMicrotask(() => openPicker("command"))
    else viewModel.closePicker()
  }
  const handlePickerKeyDown = (event: KeyboardEvent) => {
    if (!agentPickerOpen()) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (state().pickerMode !== "command" && pickerFromCommand()) pickerBack()
      else viewModel.closePicker()
      return
    }
    if (state().pickerMode !== "command") return
    const entries = commandEntries()
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (entries.length > 0) {
        const delta = event.key === "ArrowDown" ? 1 : -1
        setCommandActiveIndex((index) => {
          for (let step = 1; step <= entries.length; step += 1) {
            const nextIndex = (index + delta * step + entries.length * 2) % entries.length
            if (!entries[nextIndex]?.disabled) return nextIndex
          }
          return index
        })
      }
    } else if (event.key === "Enter") {
      const entry = entries[commandActiveIndex()]
      if (entry !== undefined && !entry.disabled) {
        event.preventDefault()
        executeCommand(entry.id)
      }
    }
  }

  onMount(() => {
    const initialTheme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
    if (initialTheme === "light") viewModel.update((current) => ({ ...current, theme: "light" }))
    const mobileQuery = window.matchMedia("(max-width: 767px)")
    const syncMobile = () => {
      setIsMobile(mobileQuery.matches)
      if (mobileQuery.matches) setSidebarOpen(false)
    }
    syncMobile()
    mobileQuery.addEventListener("change", syncMobile)
     run(loadWebSession, (error) => {
       setLoginError(error.message)
       setAuthReady(true)
     }, (authenticated) => {
      setAuthenticated(authenticated)
      setAuthReady(true)
      if (authenticated) startWorkspace()
    })
    const onKeyDown = (event: KeyboardEvent) => {
       if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyQ") {
         event.preventDefault()
         event.stopPropagation()
         setQueueDialogOpen(true)
         return
       }
       if ((event.metaKey || event.ctrlKey) && event.code === "KeyP") {
        event.preventDefault()
        event.stopPropagation()
         openPicker("command")
      }
       if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyA") {
         event.preventDefault()
         viewModel.cycleAgent()
       }
       if ((event.metaKey || event.ctrlKey) && event.code === "KeyJ") {
        event.preventDefault()
        viewModel.cycleVariant()
      }
       handlePickerKeyDown(event)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      mobileQuery.removeEventListener("change", syncMobile)
       window.removeEventListener("keydown", onKeyDown, true)
       if (autoScrollFrame !== undefined) window.cancelAnimationFrame(autoScrollFrame)
       copyGeneration += 1
        if (copyResetFiber !== undefined) effectRunner.fork(Fiber.interrupt(copyResetFiber))
        cleanupViewModel?.()
        effectRunner.close()
    }
  })

  const currentTitle = () => sessions().find((session) => session.id === selectedID())?.title ?? selectedID() ?? "No session"
  const isLight = () => theme() === "light"
  const connectionClass = (): string => {
    if (connection() === "reconnecting") return styles.reconnectingDot
    if (connection() === "disconnected") return styles.disconnectedDot
    return ""
  }
  const connectionLabel = (): string => {
    if (connection() === "connected") return "Connected"
    if (connection() === "reconnecting") return "Reconnecting"
    return "Disconnected"
  }
  const dialogContentClass = (): string => {
    if (state().pickerMode === "command") return styles.commandDialogContent
    if (state().pickerMode === "project") return styles.projectDialogContent
    if (state().pickerMode === "theme") return styles.themeDialogContent
    if (state().pickerMode === "settings") return `${styles.settingsDialogContent} settings-dialog-content`
    return ""
  }
  const commandIcon = (id: string) => {
    if (id === "project") return <FolderGit2 class={styles.pickerSelectIcon} size={18} />
    if (id === "session") return <MessageSquare class={styles.pickerSelectIcon} size={18} />
    if (id === "compact") return <Minimize2 class={styles.pickerSelectIcon} size={18} />
    if (id === "review") return <ListChecks class={styles.pickerSelectIcon} size={18} />
    if (id === "new") return <Plus class={styles.pickerSelectIcon} size={18} />
    if (id === "theme") return <Palette class={styles.pickerSelectIcon} size={18} />
    return <Sun class={styles.pickerSelectIcon} size={18} />
  }
  const submitFromKeyboard = (event: KeyboardEvent) => {
    if (event.isComposing) return
    if (event.code === "Enter" && !event.shiftKey) {
      event.preventDefault()
      viewModel.submit()
    }
  }
  const copyMessage = (text: string) => {
    const generation = ++copyGeneration
    if (copyResetFiber !== undefined) effectRunner.fork(Fiber.interrupt(copyResetFiber))
    copyResetFiber = effectRunner.run(Effect.tryPromise({
      try: () => navigator.clipboard.writeText(text),
      catch: (cause) => new AppViewModelError("copy message", cause),
    }).pipe(
      Effect.tap(() => Effect.sync(() => setCopiedMessage(text))),
      Effect.andThen(Effect.sleep("1.4 seconds")),
      Effect.tap(() => Effect.sync(() => setCopiedMessage(undefined))),
      Effect.ensuring(Effect.sync(() => { if (copyGeneration === generation) copyResetFiber = undefined })),
    ), (error) => {
      setCopiedMessage(undefined)
      viewModel.update((state) => ({ ...state, error: error.message }))
    })
  }
  const quoteMessage = (text: string) => viewModel.setText((text.split("\n").map((line) => `> ${line}`).join("\n")) + "\n\n")
  const retryMessage = (text: string) => { viewModel.setText(text); viewModel.submit() }
  const sidebarContent = () => <Sidebar
    styles={styles}
    state={state}
    isLight={isLight}
    isMobile={isMobile}
    sidebarOpen={sidebarOpen}
    directory={directory}
    projects={projects}
    visibleSessions={visibleSessions}
    pinnedSessions={pinnedSessions}
    recentSessions={recentSessions}
    pinnedSessionsOpen={pinnedSessionsOpen}
    recentSessionsOpen={recentSessionsOpen}
    sessionRow={sessionRow}
    projectLabel={projectLabel}
    createSession={createSession}
    openProjectPicker={() => openPicker("project")}
    openSettings={() => openPicker("settings")}
    setSidebar={setSidebar}
    togglePinned={() => setPinnedSessionsOpen((open) => !open)}
    toggleRecent={() => setRecentSessionsOpen((open) => !open)}
    openSessionBrowser={() => setSessionBrowserOpen(true)}
  />
  return (
     <Show when={authenticated()} fallback={
        <div class={styles.authShell}>
         <Show when={authReady()} fallback={<div class={styles.authCard}><div class={styles.authTitle}>Checking access</div><div class={styles.authCopy}>Preparing the local workspace.</div></div>}>
          <div class={styles.authLayout}>
            <section class={styles.authAside} aria-label="Kissa OpenCode workspace">
              <div>
                <div class={styles.authBrand}><span class={styles.authMark}><SquareTerminal size={18} aria-hidden="true" /></span><span>Kissa</span></div>
                <div class={styles.authAsideLead}>
                <div class={styles.authEyebrow}>Your workspace</div>
                  <h1 class={styles.authHeadline}>Back to your work.</h1>
                  <p class={styles.authAsideCopy}>A focused workspace for OpenCode.</p>
                </div>
              </div>
              <div class={styles.authSignal}><span class={styles.authSignalDot} aria-hidden="true" />Private workspace</div>
            </section>
            <form class={styles.authCard} onSubmit={submitLogin} aria-describedby="login-description">
              <div class={styles.authPanelHeader}><div class={styles.authTitle}>Sign in</div><div id="login-description" class={styles.authCopy}>Enter your details to continue.</div></div>
              <div class={styles.authForm}>
                <div class={styles.authField}><label class={styles.label} for="login-username">Username</label><input id="login-username" class={styles.nativeInput} autocomplete="username" value={loginUsername()} onInput={(event) => setLoginUsername(event.currentTarget.value)} required /></div>
                <div class={styles.authField}><label class={styles.label} for="login-password">Password</label><input id="login-password" class={styles.nativeInput} type="password" autocomplete="current-password" value={loginPassword()} onInput={(event) => setLoginPassword(event.currentTarget.value)} required /></div>
                <Show when={loginError()}><div class={styles.authError} role="alert">{loginError()}</div></Show>
                <Button class={styles.authSubmit} type="submit" loading={loginBusy()} loadingText="Signing in…">Sign in</Button>
              </div>
            </form>
          </div>
        </Show>
      </div>
    }>
    <div class={`${styles.shell} ${isLight() ? styles.lightShell : ""}`}>
       <Show when={directory().length > 0} fallback={
          <Show when={state().loading.preferences || state().loading.projects} fallback={<main class={`${styles.main} ${isLight() ? styles.lightMain : ""}`}>
           <div class={styles.projectStart}>
            <div class={styles.projectStartContent}>
              <div class={styles.projectStartMark} aria-hidden="true"><FolderGit2 size={20} /></div>
              <div class={styles.projectStartTitle}>Choose a project to begin</div>
               <div class={styles.projectStartText}>Choose a folder from your configured projects root. Existing OpenCode projects are marked; new ones are created when you start a session.</div>
               <div class={styles.projectStartField}>
                 <PickerCombobox label="Project folder" placeholder={state().loading.projects ? "Loading projects…" : "Search project folders"} value={directory()} items={projectOptions()} groupBy="group" disabled={state().loading.projects} onChange={selectProject} />
                 <Show when={!state().loading.projects && projectOptions().length === 0}><div class={styles.emptyText}>No allowed projects are available.</div></Show>
               </div>
            </div>
          </div>
         </main>}>
           <main class={`${styles.main} ${isLight() ? styles.lightMain : ""}`}>
             <div class={styles.projectStart} aria-busy="true">
               <div class={styles.projectStartContent}>
                 <div class={styles.projectStartMark} aria-hidden="true"><FolderGit2 size={20} /></div>
                 <div class={styles.projectStartTitle}>Restoring your workspace</div>
                 <div class={styles.projectStartText}>Loading your saved project and sessions from the local database.</div>
                 <div class={styles.projectLoadingLines} aria-label="Loading workspace"><span class="loading-line" /><span class="loading-line" /><span class="loading-line" /></div>
               </div>
             </div>
           </main>
         </Show>
       }>
      <div class={styles.layout}>
         <Show when={isMobile()} fallback={<aside id="session-sidebar" class={`${styles.sidebarPanel} ${styles.sidebar} ${!sidebarOpen() ? styles.closedSidebar : ""} ${isLight() ? styles.lightSidebar : ""}`} aria-label="Sessions">{sidebarContent()}</aside>}>
          <Drawer.Root open={sidebarOpen()} onOpenChange={(details) => setSidebarOpen(details.open)} variant="left">
            <Portal>
              <Drawer.Backdrop class={styles.drawerBackdrop} />
              <Drawer.Positioner class={styles.drawerPositioner}>
                <Drawer.Content id="session-sidebar" class={`${styles.sidebarPanel} ${styles.drawerContent}`}>
                  <Drawer.Title class={styles.srOnly}>Sessions and workspace</Drawer.Title>
                  <Drawer.Description class={styles.srOnly}>Choose a project, model, or session.</Drawer.Description>
                  {sidebarContent()}
                </Drawer.Content>
              </Drawer.Positioner>
            </Portal>
          </Drawer.Root>
        </Show>
        <main class={`${styles.main} ${sidebarOpen() && !isMobile() ? styles.mainWithSidebar : ""} ${isLight() ? styles.lightMain : ""}`}>
        <div class={styles.utilityRail}>
           <div class={`${styles.headerActions} ${styles.utilityStart}`}>
             <Show when={!sidebarOpen() || isMobile()}>
               <Button class={styles.sidebarToggle} variant="ghost" size="sm" aria-label="Show sidebar" aria-controls="session-sidebar" aria-expanded={sidebarOpen()} onClick={() => setSidebar(true)}><PanelLeftOpen size={18} /></Button>
             </Show>
            </div>
            <h1 class={styles.utilityTitle}>{currentTitle()}</h1>
            <div class={`${styles.headerActions} ${styles.utilityEnd}`}>
               <span class={styles.status} aria-live="polite" aria-atomic="true"><span class={`${styles.dot} ${connectionClass()}`} aria-hidden="true" />{connectionLabel()}</span>
              <Show when={connection() === "disconnected"}><Button class={styles.controlButton} variant="ghost" size="sm" aria-label="Reconnect to server" title="Reconnect to server" onClick={() => viewModel.reconnect()}><RotateCcw size={16} /></Button></Show>
           </div>
        </div>
        <Show when={state().error}>{(error) => <Alert.Root class={styles.errorBanner}><Alert.Indicator /><Alert.Content><Alert.Title>Operation failed</Alert.Title><Alert.Description>{error()}</Alert.Description></Alert.Content><Button class={styles.errorDismiss} variant="ghost" size="sm" aria-label="Dismiss error" onClick={() => viewModel.clearError()}><X size={14} /></Button></Alert.Root>}</Show>
         <Show when={selectedID() !== undefined}>
             <div class={`${styles.runStrip} ${chatWidthClass()}`}>
            <Badge variant="subtle" size="sm">{busy() ? "Active" : "Idle"}</Badge>
            <Show when={state().activity}><span>{state().activity}</span></Show>
            <Show when={state().sessionStatus?.contextTokens !== undefined}><span>{state().sessionStatus?.contextTokens?.toLocaleString()} context tokens</span></Show>
            <Show when={state().usage}>{(usage) => <span>in {usage().input.toLocaleString()} · out {usage().output.toLocaleString()} · reasoning {usage().reasoning.toLocaleString()}<Show when={usage().cost !== undefined}> · ${usage().cost?.toFixed(4)}</Show></span>}</Show>
             <Show when={queuedPrompts().length > 0}><Button class={styles.queueButton} variant="outline" size="sm" aria-haspopup="dialog" onClick={() => setQueueDialogOpen(true)}>{queuedPrompts().length} queued <span class={styles.srOnly}>prompts</span><span aria-hidden="true">· Alt+Q</span></Button></Show>
            </div>
            <span class={styles.srOnly} aria-live="polite">{state().activity ?? (busy() ? "Working" : "Idle")}</span>
           <Show when={activityLog().length > 1}>
             <details class={styles.activityLog}>
               <summary>Recent activity</summary>
                 <For each={activityLog()}>{(item) => <div><time dateTime={item.time}>{new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> {item.label}</div>}</For>
             </details>
           </Show>
         </Show>
        <QueueDialog styles={styles} open={queueDialogOpen()} prompts={queuedPrompts()} close={() => setQueueDialogOpen(false)} remove={(id) => viewModel.removeQueuedPrompt(id)} />
         <ConversationPane
           styles={styles}
           state={state}
           messages={messages}
           directory={directory}
           busy={busy}
           isLight={isLight}
            copiedMessage={copiedMessage}
            stickToBottom={stickToBottom}
            latestAvailable={latestAvailable}
            chatWidthClass={chatWidthClass}
            expandChatDetails={() => state().userSettings.expandChatDetails === "true"}
            effectRunner={effectRunner}
           copyMessage={copyMessage}
           quoteMessage={quoteMessage}
           retryMessage={retryMessage}
            requestRevert={(message) => viewModel.requestRevert(message)}
            createSession={createSession}
             openProjectPicker={() => openPicker("project")}
            jumpToLatest={jumpToLatest}
           onScroll={handleConversationScroll}
            setViewport={(element) => { conversationElement = element; syncConversationPosition() }}
          />
         <Show when={sessionPermissions().length > 0 || sessionQuestions().length > 0 || queuedPrompts().length > 0}>
           <div class={`${styles.pendingArea} ${chatWidthClass()}`} aria-label="Pending actions">
             <Show when={!pendingExpanded() && (sessionPermissions().length + sessionQuestions().length > 1)}>
               <Button class={styles.pendingToggle} variant="ghost" size="sm" onClick={() => setPendingExpanded(true)}>{sessionPermissions().length + sessionQuestions().length - 1} more requests</Button>
             </Show>
             <For each={sessionPermissions().slice(0, pendingExpanded() ? undefined : 1)}>{(permission) => (
               <section class={styles.requestCard}>
                 <div class={styles.requestHeader}><ShieldAlert size={17} /> Permission requested</div>
                 <div>{permission.action}</div>
                 <Show when={permission.resources.length > 0}><div class={styles.requestDetail}>{permission.resources.join("\n")}</div></Show>
                 <div class={styles.requestActions}>
                   <Button size="sm" disabled={state().loading.replying} onClick={() => viewModel.replyPermission(permission, "once")}>Allow once</Button>
                   <Button size="sm" variant="outline" disabled={state().loading.replying} onClick={() => viewModel.replyPermission(permission, "always")}>Always allow</Button>
                   <Button size="sm" variant="ghost" disabled={state().loading.replying} onClick={() => viewModel.replyPermission(permission, "reject")}>Reject</Button>
                 </div>
               </section>
             )}</For>
              <For each={sessionQuestions().slice(0, pendingExpanded() ? undefined : 1)}>{(request) => (
               <section class={`${styles.requestCard} ${styles.questionCard}`}>
                 <div class={styles.questionHeader}>
                   <span class={styles.questionHeaderIcon}><ListChecks size={18} aria-hidden="true" /></span>
                   <span class={styles.questionHeaderCopy}><span class={styles.questionEyebrow}>Needs your input</span><strong>Agent question</strong><span class={styles.questionDescription}>Choose an answer to continue the current run.</span></span>
                 </div>
                 <For each={request.questions}>{(question, questionIndex) => (
                   <fieldset class={styles.questionBlock}>
                     <legend class={styles.questionPrompt}>{question.question}</legend>
                     <Show when={question.header.length > 0}><div class={styles.label}>{question.header}</div></Show>
                     <div class={styles.questionOptionGrid}>
                       <For each={question.options}>{(option) => {
                         const selected = () => (state().questionDrafts[request.id]?.[questionIndex()] ?? []).includes(option.label)
                         return <Button class={styles.questionOption} size="sm" variant={selected() ? "solid" : "outline"} aria-pressed={selected()} title={option.description} onClick={() => toggleQuestionOption(request.id, questionIndex(), option.label, question.multiple)}><span class={styles.questionOptionCopy}><span>{option.label}</span><Show when={option.description.length > 0}><span class={styles.questionOptionDescription}>{option.description}</span></Show></span><Show when={selected()}><Check size={15} aria-hidden="true" /></Show></Button>
                       }}</For>
                     </div>
                     <Show when={question.custom || question.options.length === 0}>
                       <input class={`${styles.nativeInput} ${styles.questionAnswerInput}`} aria-label={`Answer: ${question.question}`} placeholder="Type your answer" value={state().questionDrafts[request.id]?.[questionIndex()]?.[0] ?? ""} onInput={(event) => viewModel.setQuestionAnswer(request.id, questionIndex(), [event.currentTarget.value])} />
                     </Show>
                   </fieldset>
              )}</For>
              <Show when={pendingExpanded()}><Button class={styles.pendingToggle} variant="ghost" size="sm" onClick={() => setPendingExpanded(false)}>Show less</Button></Show>
                 <div class={styles.questionSubmitRow}><span class={styles.questionDescription}>Your answer will be sent to the agent.</span><Button size="sm" disabled={state().loading.replying} loading={state().loading.replying} loadingText="Sending…" onClick={() => viewModel.replyQuestion(request)}>Submit answers</Button></div>
               </section>
             )}</For>
               <Show when={queuedPrompts().length > 0}><Button class={styles.pendingToggle} variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => setQueueDialogOpen(true)}>View queued prompts</Button></Show>
           </div>
        </Show>
         <Composer
          styles={styles}
          selectedID={selectedID}
          attachments={attachments}
          directory={directory}
          busy={busy}
          text={text}
          isLight={isLight}
          chatWidthClass={chatWidthClass}
          selectedModel={selectedModel}
          unavailableModel={unavailableModel}
          variantKey={variantKey}
          agents={agents}
          agentKey={agentKey}
          selectedAgent={selectedAgent}
          loadingModels={() => state().loading.models}
           switchingModel={() => state().loading.switchingModel}
           switchingVariant={() => state().loading.switchingVariant}
           switchingAgent={() => state().loading.switchingAgent}
          interrupting={() => state().loading.interrupting}
          openModelPicker={() => openPicker("model")}
          openAgentPicker={() => openPicker("agent")}
          chooseAttachments={chooseAttachments}
          updateText={updateText}
          submit={submit}
          submitFromKeyboard={submitFromKeyboard}
          interrupt={() => viewModel.interrupt()}
          removeAttachment={(id) => viewModel.removeAttachment(id)}
        />
        </main>
      </div>
      </Show>
      <Dialog.Root open={agentPickerOpen()} closeOnEscape={false} onOpenChange={(details) => { if (!details.open) { if (state().pickerMode === "settings" && settingsDirty()) { setSettingsDiscardOpen(true); return } closePicker() } }} onEscapeKeyDown={(event) => { if (pickerFromCommand() && state().pickerMode !== "command") { event.preventDefault(); pickerBack() } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
          <Dialog.Content class={dialogContentClass()}>
              <Dialog.Header>
                    <Show when={pickerFromCommand() && state().pickerMode !== "command"}><div class={styles.breadcrumb}><Button variant="ghost" size="sm" onClick={pickerBack}><Undo2 size={14} />Command</Button><span aria-hidden="true">/</span><span>{pickerCopy[state().pickerMode].breadcrumb}</span></div></Show>
                      <div class={styles.dialogTitleRow}><Dialog.Title>{pickerCopy[state().pickerMode].title}</Dialog.Title><Show when={state().pickerMode === "command"}><Badge class={styles.shortcutBadge} variant="outline" size="sm">⌘/Ctrl P</Badge></Show></div>
                       <Dialog.Description>{pickerCopy[state().pickerMode].description}</Dialog.Description>
              </Dialog.Header>
               <Dialog.Body class={state().pickerMode === "command" ? styles.commandBody : ""}>
             <Show when={state().pickerMode === "project"}>
                   <div class={styles.projectPickerIntro}><span class={styles.projectPickerIntroCopy}>Folders come from the configured projects root. Search by folder name or full path.</span><span class={styles.projectPickerCount}>{projects().length} folders</span></div>
                   <PickerCombobox label="Project folder" placeholder="Search project folders" value={directory()} items={projectOptions()} groupBy="group" loading={state().loading.projects} autoFocus onChange={selectProject} />
               </Show>
            <Show when={state().pickerMode === "model"}>
               <PickerCombobox label="Provider" placeholder="Search providers" value={modelProviderKey()} items={providerOptions()} loading={state().loading.models} autoFocus disabled={state().loading.switchingModel || state().loading.switchingVariant} onChange={selectModelProvider} />
              <Show when={modelProviderKey().length > 0}>
                  <PickerCombobox label="Model" placeholder="Search models" value={modelValueForProvider()} items={modelOptions()} activeValue={modelKey()} loading={state().loading.models} disabled={state().loading.switchingModel || state().loading.switchingVariant} onChange={selectModel} />
              </Show>
              <Show when={unavailableModel()}>
                <div class={styles.unavailableModel} role="status">
                  <strong>Current model is unavailable</strong>
                  <span class={styles.unavailableDetail}>{modelKey()}</span>
                  <span>Choose another model to continue.</span>
                </div>
              </Show>
              <Show when={providerSelectedModel() !== undefined}>
                    <Show when={variantOptions().length <= 4} fallback={<PickerCombobox label="Variant" placeholder="Choose a variant" value={variantKey() || defaultVariantValue} items={variantOptions()} activeValue={variantKey() || defaultVariantValue} disabled={state().loading.switchingModel || state().loading.switchingVariant} onChange={(value) => selectVariant(value === defaultVariantValue ? "" : value)} />}>
                      <div class={styles.controlSection}>
                        <div class={styles.label}>Variant</div>
                        <div class={styles.variantOptions} role="group" aria-label="Model variant">
                          <For each={variantOptions()}>{(option) => <Button class={`${styles.variantOption} ${option.value === (variantKey() || defaultVariantValue) ? styles.variantOptionActive : ""}`} variant="ghost" size="sm" aria-pressed={option.value === (variantKey() || defaultVariantValue)} disabled={state().loading.switchingModel || state().loading.switchingVariant} onClick={() => selectVariant(option.value === defaultVariantValue ? "" : option.value)}><span>{option.label}</span><span class={styles.optionDetail}>{option.detail ?? "Model response style"}</span></Button>}</For>
                        </div>
                      </div>
                    </Show>
              </Show>
            </Show>
            <Show when={state().pickerMode === "command"}>
                <input ref={(element) => { commandInputElement = element }} class={styles.nativeInput} aria-label="Filter commands" placeholder="Search commands" value={commandQuery()} onInput={(event) => { setCommandQuery(event.currentTarget.value); setCommandActiveIndex(0) }} />
               <div class={styles.commandList} role="listbox" aria-label="Commands">
                 <For each={commandEntries()}>{(entry, index) => <Button class={`${styles.pickerSelect} ${index() === commandActiveIndex() ? styles.commandActive : ""}`} variant="ghost" role="option" aria-selected={index() === commandActiveIndex()} disabled={entry.disabled} onMouseEnter={() => setCommandActiveIndex(index())} onClick={() => executeCommand(entry.id)}>
                    {commandIcon(entry.id)}
                    <span class={styles.pickerSelectCopy}><span class={styles.pickerSelectTitle}>{entry.label}</span><span class={styles.pickerSelectDetail}>{entry.detail}</span></span><span class={styles.commandKeys} aria-hidden="true"><ArrowUp size={12} /><ArrowDown size={12} /> Enter</span>
                 </Button>}</For>
                  <Show when={commandEntries().length === 0}><div class={styles.commandEmpty}><span class={styles.commandEmptyTitle}>No commands found</span><span>Try a shorter search or clear the filter.</span></div></Show>
               </div>
            </Show>
              <Show when={state().pickerMode === "quickOpen"}>
                <Show when={sessions().length > 0}>
                   <PickerCombobox label="Session" placeholder="Search sessions" value={selectedID() ?? ""} items={visibleSessionOptions()} autoFocus onChange={selectSessionFromPicker} />
               </Show>
               <Show when={sessions().length === 0}><div class={styles.emptyText}>No sessions in this project yet.</div></Show>
             </Show>
             <Show when={state().pickerMode === "quickOpen" && subagents().length > 0}>
                <PickerCombobox label="Subagent" placeholder="Search subagents" value={subagents().some((session) => session.id === selectedID()) ? selectedID() ?? "" : ""} items={subagents().map((session) => ({ label: sessionLabel(session), value: session.id, detail: sessionIDLabel(session.id) }))} onChange={selectSessionFromPicker} />
             </Show>
                <Show when={state().pickerMode === "theme"}><ThemePicker light={isLight()} family={themeFamily()} onThemeChange={(value) => viewModel.setTheme(value)} onFamilyChange={(value) => viewModel.setThemeFamily(value)} /></Show>
               <Show when={state().pickerMode === "settings"}><SettingsDialog styles={styles} light={settingsThemeBase() === "light"} family={settingsFamilyBase()} chatWidth={chatWidth()} hideSubagents={hideSubagents()} sidebarOpen={sidebarOpen()} expandChatDetails={state().userSettings.expandChatDetails === "true"} showAllSessions={state().userSettings.showAllSessions === "true"} mediaDirectories={state().userSettings.mediaDirectories ?? ""} observability={state().observability} observabilityLoading={state().loading.observability} refreshObservability={() => viewModel.loadObservability()} onThemePreview={(theme, family) => { viewModel.setTheme(theme); viewModel.setThemeFamily(family) }} onDirtyChange={setSettingsDirty} closeSettings={closePicker} saveSettings={(settings) => { setSettingsThemeBase(settings.theme); setSettingsFamilyBase(settings.themeFamily); viewModel.setTheme(settings.theme); viewModel.setThemeFamily(settings.themeFamily); viewModel.setUserSetting("chatWidth", settings.chatWidth); viewModel.setUserSetting("hideSubagents", settings.hideSubagents ? "true" : "false"); viewModel.setUserSetting("expandChatDetails", settings.expandChatDetails ? "true" : "false"); viewModel.setUserSetting("showAllSessions", settings.showAllSessions ? "true" : "false"); viewModel.setUserSetting("mediaDirectories", settings.mediaDirectories); setSidebar(settings.sidebarOpen) }} /></Show>
               <Show when={state().pickerMode === "agent"}>
                 <div class={styles.controlSection}>
                   <PickerCombobox label="Agent" placeholder={state().loading.agents ? "Loading agents…" : "Choose an agent"} value={agentKey()} activeValue={agentKey()} items={agentOptions()} loading={state().loading.agents} autoFocus disabled={state().loading.agents || state().loading.switchingAgent} onChange={selectAgent} />
                </div>
               </Show>
               <Show when={state().pickerMode === "control"}>
                <div class={styles.controlSection}>
                 <div class={styles.label}>Run</div>
                <div class={styles.requestActions}>
                  <Button size="sm" variant="outline" disabled={selectedID() === undefined || state().loading.loadingStatus} onClick={() => { const id = selectedID(); if (id !== undefined) { viewModel.loadStatus(id); viewModel.loadMessages(id) } }}><Play size={15} /> Resume stream</Button>
                  <Button size="sm" variant="outline" disabled={!busy() || state().loading.interrupting} loading={state().loading.interrupting} onClick={() => viewModel.interrupt()}><Square size={14} /> Stop</Button>
                  <Button size="sm" variant="outline" disabled={selectedID() === undefined || busy() || state().loading.compacting} loading={state().loading.compacting} onClick={() => viewModel.compact()}><Minimize2 size={15} /> Compact</Button>
                  <Button size="sm" variant="ghost" disabled={selectedID() === undefined || state().loading.loadingStatus} onClick={() => { const id = selectedID(); if (id !== undefined) viewModel.loadStatus(id) }}><Gauge size={15} /> Refresh status</Button>
                </div>
              </div>
              <div class={styles.controlSection}>
                <div class={styles.label}>Review changes</div>
                <input class={styles.nativeInput} aria-label="Review focus" placeholder="Optional focus, for example tests or security" value={state().reviewFocus} onInput={(event) => viewModel.setReviewFocus(event.currentTarget.value)} />
                <Button size="sm" disabled={selectedID() === undefined} onClick={() => viewModel.submitReview()}>Queue review</Button>
              </div>
              <div class={styles.controlSection}>
                <div class={styles.label}>Open directory</div>
                <div class={styles.formRow}><input class={styles.nativeInput} aria-label="Directory path" placeholder="/absolute/project/path" value={state().directDirectory} onInput={(event) => viewModel.setDirectDirectory(event.currentTarget.value)} /><Button size="sm" onClick={() => viewModel.applyDirectDirectory()}>Open</Button></div>
              </div>
              <div class={styles.controlSection}>
                <div class={styles.label}>Open session by ID</div>
                <div class={styles.formRow}><input class={styles.nativeInput} aria-label="Session ID" placeholder="Session ID" value={state().directSessionID} onInput={(event) => viewModel.setDirectSessionID(event.currentTarget.value)} /><Button size="sm" onClick={() => viewModel.applyDirectSessionID()}>Open</Button></div>
              </div>
            </Show>
              </Dialog.Body>
              <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} class={`${triggerProps().class ?? ""} ${styles.dialogClose}`} variant="ghost" size="sm" aria-label="Close"><X size={16} /></Button>} />
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
       </Dialog.Root>
       <Dialog.Root open={settingsDiscardOpen()} onOpenChange={(details) => setSettingsDiscardOpen(details.open)}>
         <Portal>
           <Dialog.Backdrop />
           <Dialog.Positioner>
             <Dialog.Content>
               <Dialog.Header>
                 <Dialog.Title>Discard unsaved changes?</Dialog.Title>
                 <Dialog.Description>Your settings changes will be lost if you close this panel.</Dialog.Description>
               </Dialog.Header>
               <Dialog.Body>
                 <div class={styles.requestActions}>
                   <Button variant="ghost" onClick={() => setSettingsDiscardOpen(false)}>Keep editing</Button>
                   <Button variant="outline" onClick={closePicker}>Discard changes</Button>
                 </div>
               </Dialog.Body>
               <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} class={`${triggerProps().class ?? ""} ${styles.dialogClose}`} variant="ghost" size="sm" aria-label="Close"><X size={16} /></Button>} />
             </Dialog.Content>
           </Dialog.Positioner>
         </Portal>
       </Dialog.Root>
       <Dialog.Root open={sessionBrowserOpen()} onOpenChange={(details) => setSessionBrowserOpen(details.open)}>
         <Portal>
           <Dialog.Backdrop />
           <Dialog.Positioner>
              <Dialog.Content>
               <Dialog.Header>
                 <Dialog.Title>All sessions</Dialog.Title>
                 <Dialog.Description>Browse the full session history for this workspace.</Dialog.Description>
               </Dialog.Header>
               <Dialog.Body>
                 <div class={styles.allSessions} aria-label="All sessions">
                   <Show when={allPinnedSessions().length > 0}>
                     <div class={styles.allSessionsGroup}>Pinned</div>
                     <For each={allPinnedSessions()}>{sessionRow}</For>
                   </Show>
                   <Show when={allRecentSessions().length > 0}>
                     <div class={styles.allSessionsGroup}>Recent</div>
                     <For each={allRecentSessions()}>{sessionRow}</For>
                   </Show>
                 </div>
               </Dialog.Body>
               <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} class={`${triggerProps().class ?? ""} ${styles.dialogClose}`} variant="ghost" size="sm" aria-label="Close"><X size={16} /></Button>} />
             </Dialog.Content>
           </Dialog.Positioner>
         </Portal>
       </Dialog.Root>
       <Dialog.Root open={state().revertTarget !== undefined} onOpenChange={(details) => { if (!details.open) viewModel.closeRevert() }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Revert session</Dialog.Title>
                <Dialog.Description>Return this session to the selected message.</Dialog.Description>
              </Dialog.Header>
              <Dialog.Body>
                <div class={styles.revertSummary}>{state().revertTarget?.text}</div>
                <p class={styles.revertWarning}>Messages after this point and their file changes will be reverted.</p>
                <div class={styles.revertActions}>
                  <Button variant="ghost" disabled={state().loading.reverting} onClick={() => viewModel.closeRevert()}>Cancel</Button>
                  <Button loading={state().loading.reverting} loadingText="Reverting…" disabled={busy()} onClick={() => viewModel.confirmRevert()}><Undo2 size={15} /> Revert</Button>
                </div>
              </Dialog.Body>
              <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} class={`${triggerProps().class ?? ""} ${styles.dialogClose}`} variant="ghost" size="sm" aria-label="Close"><X size={16} /></Button>} />
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </div>
    </Show>
  )
}

import { For, Show } from "solid-js"
import { css } from "../styled-system/css"
import type { ThemeFamily } from "../state/app-view-model"
import { Button } from "./ui/button"
import { Check, Moon, Sun } from "lucide-solid"

const themePaletteGroups = [
  { label: "Core palettes", description: "Distinctive paired surfaces for focused work.", palettes: [
    { family: "cosmic", label: "Cosmic", detail: "Cosmic dawn / deep space", swatches: ["#080d1c", "#263c73", "#8aa7ff", "#eef3ff"] },
    { family: "amethyst", label: "Amethyst", detail: "Lavender mist / amethyst night", swatches: ["#171126", "#4b326f", "#a98bdb", "#f2edff"] },
    { family: "meadow", label: "Meadow", detail: "Meadow light / quiet grove", swatches: ["#10251c", "#2f5b43", "#72ad78", "#edf6e8"] },
    { family: "komorebi", label: "Komorebi", detail: "Komorebi / tsukikage", swatches: ["#17231d", "#394f42", "#b49b58", "#f2ead2"] },
    { family: "coffee", label: "Coffee", detail: "Roast, paper, and amber", swatches: ["#100805", "#432418", "#c8874d", "#f4e5d1"] },
    { family: "tokyo", label: "Tokyo", detail: "Ink, indigo, and violet", swatches: ["#1a1b26", "#283457", "#7aa2f7", "#bb9af7"] },
  ] },
  {
    label: "Seasonal light",
    description: "Expressive color stories that shift with the season.",
    palettes: [
      { family: "spring", label: "Spring", detail: "Blossom and plum", swatches: ["#211b2b", "#49304b", "#f2a6c2", "#f7d7e8"] },
      { family: "summer", label: "Summer", detail: "Sun, sea, and citrus", swatches: ["#0c1f2b", "#16495c", "#e7b94c", "#fff8df"] },
      { family: "autumn", label: "Autumn", detail: "Rust, bark, and ember", swatches: ["#241812", "#5b2c1e", "#d47c4a", "#f5ead6"] },
      { family: "winter", label: "Winter", detail: "Frost and blue hour", swatches: ["#101b2a", "#243b55", "#8fc4e8", "#f3f8fc"] },
    ],
  },
  {
    label: "Quiet materials",
    description: "Low-noise surfaces for focused work.",
    palettes: [
      { family: "monochrome", label: "Monochrome", detail: "Charcoal and ash", swatches: ["#171717", "#3b3b3b", "#8b8b8b", "#f2f2f2"] },
      { family: "paper", label: "Paper", detail: "Ink and warm stock", swatches: ["#29231c", "#5a4c3d", "#b58a5a", "#f4efe4"] },
    ],
  },
] as const

const styles = {
  section: css({ display: "flex", flexDir: "column", gap: "3", mb: "6" }),
  sectionHeader: css({ display: "flex", flexDir: "column", gap: "1" }),
  sectionTitle: css({ color: "var(--coffee-text)", fontSize: "sm", fontWeight: "semibold" }),
  sectionDescription: css({ color: "var(--coffee-text-muted)", fontSize: "xs", lineHeight: "1.5" }),
  modeSection: css({ display: "flex", flexDir: "column", gap: "3", pb: "3", borderBottom: "1px solid", borderColor: "var(--coffee-border)" }),
  modeGrid: css({ display: "grid", gridTemplateColumns: { base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: "2" }),
  modeButton: css({ position: "relative", w: "full", minH: "20", display: "flex", alignItems: "flex-start", gap: "3", p: "3", pr: { base: "10", md: "12" }, border: "1px solid", borderColor: "var(--coffee-border)", borderRadius: "lg", bg: "var(--coffee-surface)", color: "var(--coffee-text)", textAlign: "left", transition: "background 160ms ease, border-color 160ms ease, transform 160ms ease", _hover: { bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-border-strong)", transform: "translateY(-1px)" }, _focusVisible: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "2px" } }),
  modeButtonActive: css({ borderColor: "var(--coffee-accent-strong)", bg: "var(--coffee-glow)", color: "var(--coffee-text)", fontWeight: "semibold" }),
  modeIcon: css({ display: "grid", placeItems: "center", w: "8", h: "8", flexShrink: "0", borderRadius: "md", bg: "var(--coffee-canvas)", color: "var(--coffee-accent-strong)" }),
  modeCopy: css({ minW: "0", display: "flex", flexDir: "column", gap: "1" }),
  modeLabel: css({ fontSize: "sm", fontWeight: "semibold" }),
  modeDetail: css({ color: "var(--coffee-text-muted)", fontSize: "xs", lineHeight: "1.45" }),
  paletteGrid: css({ display: "grid", gridTemplateColumns: { base: "1fr", sm: "repeat(auto-fit, minmax(180px, 1fr))" }, gap: "2" }),
  palette: css({ position: "relative", minW: "0", display: "flex", flexDir: "column", alignItems: "stretch", gap: "3", p: "3", border: "1px solid transparent", borderRadius: "lg", bg: "var(--coffee-surface)", color: "var(--coffee-text)", textAlign: "left", cursor: "pointer", transition: "border-color 160ms ease, background 160ms ease, transform 160ms ease", _hover: { bg: "var(--coffee-surface-raised)", borderColor: "var(--coffee-border-strong)", transform: "translateY(-1px)" }, _focusVisible: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "2px" } }),
  paletteActive: css({ borderColor: "var(--coffee-accent-strong)", bg: "var(--coffee-glow)", color: "var(--coffee-text)", fontWeight: "semibold" }),
  paletteCheck: css({ position: "absolute", top: "3", right: "3", display: "grid", placeItems: "center", w: "6", h: "6", borderRadius: "full", bg: "var(--coffee-accent)", color: "var(--coffee-on-accent)" }),
  swatches: css({ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", h: "12", overflow: "hidden", borderRadius: "md", border: "1px solid rgba(255,255,255,.12)" }),
  swatch: css({ minW: "0" }),
  paletteCopy: css({ display: "flex", flexDir: "column", gap: "0.5" }),
  paletteTitle: css({ fontSize: "sm", fontWeight: "semibold" }),
  paletteDetail: css({ color: "var(--coffee-text-muted)", fontSize: "xs", lineHeight: "1.4" }),
}

const modeCopy = {
  cosmic: { lightLabel: "Cosmic dawn", lightDetail: "A pale horizon with cool morning light.", darkLabel: "Deep space", darkDetail: "A quiet blue-black sky for deep focus." },
  amethyst: { lightLabel: "Lavender mist", lightDetail: "A soft violet canvas with quiet contrast.", darkLabel: "Amethyst night", darkDetail: "A deep purple workspace for focused sessions." },
  meadow: { lightLabel: "Meadow light", lightDetail: "A fresh green canvas with open daylight.", darkLabel: "Quiet grove", darkDetail: "A shaded green workspace for calm focus." },
  komorebi: { lightLabel: "Komorebi", lightDetail: "Sunlight filtered through a quiet canopy.", darkLabel: "Tsukikage", darkDetail: "Moon shadow over a deep blue-green grove." },
  coffee: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  tokyo: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  spring: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  summer: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  autumn: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  winter: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  monochrome: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
  paper: { lightLabel: "Light mode", lightDetail: "A clear, open canvas for daytime work.", darkLabel: "Dark mode", darkDetail: "A low-glare canvas for focused sessions." },
} satisfies Readonly<Record<ThemeFamily, {
  readonly lightLabel: string
  readonly lightDetail: string
  readonly darkLabel: string
  readonly darkDetail: string
}>>

export function ThemePicker(props: { readonly light: boolean; readonly family: ThemeFamily; readonly onThemeChange: (theme: "light" | "dark") => void; readonly onFamilyChange: (family: ThemeFamily) => void; readonly showModeTitle?: boolean }) {
  const copy = () => modeCopy[props.family]
  return (
    <>
      <div class={styles.modeSection}>
        <div class={styles.sectionHeader}>
          <div class={styles.sectionTitle}>Theme</div>
          <div class={styles.sectionDescription}>Choose the base contrast for the workspace.</div>
        </div>
        <div class={styles.modeGrid} role="group" aria-label="Theme mode">
           <Button class={`${styles.modeButton} ${props.light ? styles.modeButtonActive : ""}`} variant="ghost" autofocus={props.light} aria-pressed={props.light} onClick={() => props.onThemeChange("light")}><span class={styles.modeIcon}><Sun size={16} /></span><span class={styles.modeCopy}><span class={styles.modeLabel}>{copy().lightLabel}</span><span class={styles.modeDetail}>{copy().lightDetail}</span></span><Show when={props.light}><span class={styles.paletteCheck}><Check size={14} aria-hidden="true" /></span></Show></Button>
            <Button class={`${styles.modeButton} ${!props.light ? styles.modeButtonActive : ""}`} variant="ghost" autofocus={!props.light} aria-pressed={!props.light} onClick={() => props.onThemeChange("dark")}><span class={styles.modeIcon}><Moon size={16} /></span><span class={styles.modeCopy}><span class={styles.modeLabel}>{copy().darkLabel}</span><span class={styles.modeDetail}>{copy().darkDetail}</span></span><Show when={!props.light}><span class={styles.paletteCheck}><Check size={14} aria-hidden="true" /></span></Show></Button>
        </div>
      </div>
      <For each={themePaletteGroups}>{(group) => (
        <section class={styles.section} aria-labelledby={`theme-group-${group.label.toLowerCase().replaceAll(" ", "-")}`}>
          <div class={styles.sectionHeader}>
            <div id={`theme-group-${group.label.toLowerCase().replaceAll(" ", "-")}`} class={styles.sectionTitle}>{group.label}</div>
            <div class={styles.sectionDescription}>{group.description}</div>
          </div>
          <div class={styles.paletteGrid} role="group" aria-label={`${group.label} palettes`}>
            <For each={group.palettes}>{(palette) => (
              <button class={`${styles.palette} ${props.family === palette.family ? styles.paletteActive : ""}`} type="button" aria-pressed={props.family === palette.family} onClick={() => props.onFamilyChange(palette.family)}>
                <span class={styles.swatches} aria-hidden="true"><For each={palette.swatches}>{(swatch) => <span class={styles.swatch} style={{ background: swatch }} />}</For></span>
                <span class={styles.paletteCopy}><span class={styles.paletteTitle}>{palette.label}</span><span class={styles.paletteDetail}>{palette.detail}</span></span>
                <Show when={props.family === palette.family}><span class={styles.paletteCheck}><Check size={14} aria-hidden="true" /></span></Show>
              </button>
            )}</For>
          </div>
        </section>
      )}</For>
    </>
  )
}

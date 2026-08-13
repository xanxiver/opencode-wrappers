import { renderMermaid } from "@vercel/beautiful-mermaid"
import { Resvg } from "@resvg/resvg-js"
import { Data, Effect, Option } from "effect"
import { fileURLToPath } from "node:url"
import { logBoundary } from "../core/logging.js"

const MAX_MERMAID_BLOCKS = 5
const MAX_MERMAID_SOURCE_LENGTH = 100_000
const MAX_MERMAID_PNG_BYTES = 20 * 1024 * 1024
const MAX_MERMAID_PNG_DIMENSION = 4_096
const MIN_MERMAID_PNG_LONG_EDGE = 1_920
const MERMAID_RENDER_SCALE = 2
const DIAGRAM_FONT = "Geist"
const DIAGRAM_FONT_FILE = fileURLToPath(new URL(
  "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf",
  import.meta.url,
))
const DIAGRAM_BACKGROUND = "#09090b"

const RASTER_COLORS = {
  "--bg": DIAGRAM_BACKGROUND,
  "--fg": "#fafafa",
  "--line": "#71717a",
  "--accent": "#60a5fa",
  "--muted": "#a1a1aa",
  "--surface": "#18181b",
  "--border": "#52525b",
  "--_text": "#fafafa",
  "--_text-sec": "#d4d4d8",
  "--_text-muted": "#a1a1aa",
  "--_text-faint": "#71717a",
  "--_line": "#71717a",
  "--_arrow": "#60a5fa",
  "--_node-fill": "#18181b",
  "--_node-stroke": "#52525b",
  "--_group-fill": DIAGRAM_BACKGROUND,
  "--_group-hdr": "#18181b",
  "--_inner-stroke": "#3f3f46",
  "--_key-badge": "#27272a",
} as const

interface TextSegment {
  readonly type: "text"
  readonly value: string
}

interface MermaidSegment {
  readonly type: "mermaid"
  readonly raw: string
  readonly source: string
}

type Segment = TextSegment | MermaidSegment

export interface MermaidMediaArtifact {
  readonly key: string
  readonly name: string
  readonly mime: "image/png"
  readonly bytes: Uint8Array
  readonly delivery: "document"
}

export interface TelegramRenderedMermaid {
  readonly text: string
  readonly media: readonly MermaidMediaArtifact[]
}

export class MermaidRenderError extends Data.TaggedError("MermaidRenderError")<{
  readonly diagram: number
  readonly cause: unknown
}> {}

const linesWithEndings = (text: string): readonly string[] =>
  text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? []

const splitLineEnding = (line: string) => {
  const ending = line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? ""
  return { body: ending.length === 0 ? line : line.slice(0, -ending.length), ending }
}

/** Split completed Mermaid fences from ordinary response text. */
export const mermaidSegments = (text: string): readonly Segment[] => {
  const lines = linesWithEndings(text)
  const segments: Segment[] = []
  let plain = ""
  let index = 0

  const pushPlain = () => {
    if (plain.length > 0) segments.push({ type: "text", value: plain })
    plain = ""
  }

  while (index < lines.length) {
    const openingLine = splitLineEnding(lines[index] ?? "")
    const opening = openingLine.body.match(/(`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+(.*?))?[ \t]*$/i)
    if (opening === null || opening === undefined) {
      plain += lines[index] ?? ""
      index += 1
      continue
    }

    const marker = opening[1]
    if (marker === undefined) {
      plain += lines[index] ?? ""
      index += 1
      continue
    }
    const openingAt = opening.index ?? 0
    plain += openingLine.body.slice(0, openingAt)
    const openingSource = opening[2]?.trim() ?? ""
    const closingPattern = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}`)
    const inlineClosingPattern = new RegExp(`[ \\t]+${marker[0]}{${marker.length},}[ \\t]*$`)
    const inlineClosing = openingSource.match(inlineClosingPattern)
    if (inlineClosing !== null && inlineClosing.index !== undefined) {
      pushPlain()
      segments.push({
        type: "mermaid",
        raw: openingLine.body.slice(openingAt),
        source: openingSource.slice(0, inlineClosing.index).trimEnd(),
      })
      index += 1
      continue
    }
    let closing = index + 1
    while (closing < lines.length && !closingPattern.test(lines[closing] ?? "")) closing += 1
    if (closing >= lines.length) {
      plain += openingLine.body.slice(openingAt) + openingLine.ending + lines.slice(index + 1).join("")
      break
    }

    pushPlain()
    const body = lines.slice(index + 1, closing).join("").replace(/(?:\r\n|\n|\r)$/, "")
    const source = openingSource.length === 0
      ? body
      : `${openingSource}${openingLine.ending || "\n"}${body}`
    const closingLine = splitLineEnding(lines[closing] ?? "")
    const closingMarker = closingLine.body.match(new RegExp(`${marker[0]}{${marker.length},}`))
    const closingEnd = closingMarker?.index === undefined
      ? closingLine.body.length
      : closingMarker.index + closingMarker[0].length
    const raw = openingLine.body.slice(openingAt) + openingLine.ending
      + lines.slice(index + 1, closing).join("")
      + closingLine.body.slice(0, closingEnd)
    segments.push({ type: "mermaid", raw, source })
    if (closingMarker?.index !== undefined) {
      plain += closingLine.body.slice(closingEnd)
      plain += closingLine.ending
    }
    index = closing + 1
  }

  pushPlain()
  return segments
}

const checksum = (value: string): string => {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Resolve browser CSS variables before the SVG enters the native PNG rasterizer. */
export const resolveSvgRasterColors = (svg: string): string => {
  let resolved = svg
  for (const [variable, color] of Object.entries(RASTER_COLORS)) {
    resolved = resolved.replaceAll(`var(${variable})`, color)
  }
  return resolved
}

type EventEntityKind = "ui" | "processor" | "command" | "readmodel" | "event"

interface EventFrame {
  readonly frameID: string
  readonly kind: EventEntityKind
  readonly entity: string
  readonly lane: string
  readonly data?: string
  readonly sources: readonly string[]
  readonly resetsFlow: boolean
}

interface EventPalette {
  readonly fill: string
  readonly stroke: string
}

const eventKind = (value: string): EventEntityKind | undefined => {
  switch (value.toLowerCase()) {
    case "ui": return "ui"
    case "pcr":
    case "processor": return "processor"
    case "cmd":
    case "command": return "command"
    case "rmo":
    case "readmodel": return "readmodel"
    case "evt":
    case "event": return "event"
    default: return undefined
  }
}

const xml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")

const eventKindLabel = (kind: EventEntityKind): string => {
  switch (kind) {
    case "ui": return "UI"
    case "processor": return "PROCESSOR"
    case "command": return "COMMAND"
    case "readmodel": return "READ MODEL"
    case "event": return "EVENT"
  }
}

const eventLaneGroup = (kind: EventEntityKind): string => {
  switch (kind) {
    case "ui":
    case "processor": return "UI / AUTOMATION"
    case "command":
    case "readmodel": return "COMMAND / READ MODEL"
    case "event": return "EVENTS"
  }
}

const eventColor = (kind: EventEntityKind): EventPalette => {
  switch (kind) {
    case "ui": return { fill: "#172554", stroke: "#60a5fa" }
    case "processor": return { fill: "#1e1b4b", stroke: "#818cf8" }
    case "command": return { fill: "#27272a", stroke: "#a1a1aa" }
    case "readmodel": return { fill: "#052e16", stroke: "#4ade80" }
    case "event": return { fill: "#431407", stroke: "#fb923c" }
  }
}

const displayEntity = (entity: string): string => {
  const name = entity.includes(".") ? entity.slice(entity.indexOf(".") + 1) : entity
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
}

const eventDataPreview = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > 54 ? `${compact.slice(0, 51)}...` : compact
}

const parseEventModel = (source: string): readonly EventFrame[] => {
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim().toLowerCase() !== "eventmodeling") throw new Error("Invalid event modeling header")
  const dataBlocks = new Map<string, string>()
  for (let index = 1; index < lines.length; index += 1) {
    const opening = lines[index]?.trim().match(/^data\s+([\w.-]+)(?:\s+`\w+`)?\s*\{(.*)$/i)
    if (opening === null || opening === undefined) continue
    const body: string[] = [opening[2] ?? ""]
    while (!body.at(-1)?.includes("}") && index + 1 < lines.length) {
      index += 1
      body.push(lines[index] ?? "")
    }
    dataBlocks.set(opening[1] ?? "", body.join(" ").replace(/}\s*$/, "").trim())
  }

  const frames: EventFrame[] = []
  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("%%") || /^data\s+/i.test(line)) continue
    const match = line.match(/^(tf|timeframe|rf|resetframe)\s+(\S+)\s+(\S+)\s+([\w.-]+)(.*)$/i)
    if (match === null) continue
    const kind = eventKind(match[3] ?? "")
    if (kind === undefined) throw new Error(`Unsupported event modeling entity type: ${match[3] ?? ""}`)
    const entity = match[4] ?? ""
    const remainder = match[5] ?? ""
    const reference = remainder.match(/\[\[([\w.-]+)\]\]/)?.[1]
    const inline = remainder.match(/(?:`\w+`)?\s*\{(.*)\}/)?.[1]?.trim()
    const namespace = entity.includes(".") ? entity.slice(0, entity.indexOf(".")) : ""
    const group = eventLaneGroup(kind)
    frames.push({
      frameID: match[2] ?? "",
      kind,
      entity,
      lane: namespace.length === 0 ? group : `${namespace.toUpperCase()} · ${group}`,
      data: inline ?? (reference === undefined ? undefined : dataBlocks.get(reference)),
      sources: [...remainder.matchAll(/->>\s*(\S+)/g)].map((sourceMatch) => sourceMatch[1] ?? ""),
      resetsFlow: /^(rf|resetframe)$/i.test(match[1] ?? ""),
    })
  }
  if (frames.length === 0) throw new Error("Event modeling diagram has no time frames")
  return frames
}

const renderEventModel = (source: string): string => {
  const frames = parseEventModel(source)
  const lanes = [...new Set(frames.map((frame) => frame.lane))]
  const laneIndex = new Map(lanes.map((lane, index) => [lane, index]))
  const frameIndex = new Map(frames.map((frame, index) => [frame.frameID, index]))
  const columnWidth = 250
  const laneHeight = 190
  const left = 230
  const top = 90
  const width = left + frames.length * columnWidth + 50
  const height = top + lanes.length * laneHeight + 40
  const connectors: string[] = []
  const cards: string[] = []

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    if (frame === undefined) continue
    const lane = laneIndex.get(frame.lane) ?? 0
    const x = left + index * columnWidth + 20
    const y = top + lane * laneHeight + 38
    const centerX = x + 95
    const centerY = y + 52
    const explicitSources = frame.sources.map((id) => frameIndex.get(id)).filter((value) => value !== undefined)
    let sources: readonly number[] = explicitSources
    if (explicitSources.length === 0) sources = frame.resetsFlow || index === 0 ? [] : [index - 1]
    for (const sourceIndex of sources) {
      const sourceFrame = frames[sourceIndex]
      if (sourceFrame === undefined) continue
      const sourceLane = laneIndex.get(sourceFrame.lane) ?? 0
      const sourceX = left + sourceIndex * columnWidth + 210
      const sourceY = top + sourceLane * laneHeight + 90
      connectors.push(`<path d="M ${sourceX} ${sourceY} C ${sourceX + 45} ${sourceY}, ${x - 45} ${centerY}, ${x} ${centerY}" fill="none" stroke="#71717a" stroke-width="3" marker-end="url(#arrow)"/>`)
    }
    const color = eventColor(frame.kind)
    const preview = eventDataPreview(frame.data)
    cards.push([
      `<g>`,
      `<rect x="${x}" y="${y}" width="190" height="104" rx="10" fill="${color.fill}" stroke="${color.stroke}" stroke-width="2"/>`,
      `<text x="${x + 14}" y="${y + 23}" font-family="${DIAGRAM_FONT}, sans-serif" font-size="11" font-weight="700" fill="${color.stroke}">${eventKindLabel(frame.kind)} · ${xml(frame.frameID)}</text>`,
      `<text x="${centerX}" y="${y + 53}" text-anchor="middle" font-family="${DIAGRAM_FONT}, sans-serif" font-size="16" font-weight="600" fill="#fafafa">${xml(displayEntity(frame.entity))}</text>`,
      preview === undefined ? "" : `<text x="${centerX}" y="${y + 78}" text-anchor="middle" font-family="${DIAGRAM_FONT}, sans-serif" font-size="10" fill="#d4d4d8">${xml(preview)}</text>`,
      frame.resetsFlow ? `<text x="${x + 176}" y="${y + 22}" text-anchor="end" font-family="${DIAGRAM_FONT}, sans-serif" font-size="10" fill="#a1a1aa">RESET</text>` : "",
      `</g>`,
    ].join(""))
  }

  const laneBackgrounds = lanes.map((lane, index) => {
    const y = top + index * laneHeight
    return `<rect x="20" y="${y}" width="${width - 40}" height="${laneHeight - 8}" rx="8" fill="${index % 2 === 0 ? "#18181b" : "#111113"}" stroke="#3f3f46"/><text x="38" y="${y + 34}" font-family="${DIAGRAM_FONT}, sans-serif" font-size="13" font-weight="700" fill="#d4d4d8">${xml(lane)}</text>`
  }).join("")
  const timeline = frames.map((frame, index) => {
    const x = left + index * columnWidth + 115
    return `<line x1="${x}" y1="54" x2="${x}" y2="72" stroke="#52525b"/><text x="${x}" y="42" text-anchor="middle" font-family="${DIAGRAM_FONT}, sans-serif" font-size="12" font-weight="700" fill="#a1a1aa">${xml(frame.frameID)}</text>`
  }).join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${DIAGRAM_BACKGROUND}"/><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#60a5fa"/></marker></defs><text x="24" y="42" font-family="${DIAGRAM_FONT}, sans-serif" font-size="20" font-weight="700" fill="#fafafa">Event Model</text><line x1="${left}" y1="60" x2="${width - 45}" y2="60" stroke="#52525b" stroke-width="2"/>${laneBackgrounds}${timeline}${connectors.join("")}${cards.join("")}</svg>`
}

const renderDiagram = (source: string, diagram: number): Effect.Effect<string, MermaidRenderError> =>
  source.length > MAX_MERMAID_SOURCE_LENGTH
    ? Effect.fail(new MermaidRenderError({ diagram, cause: "Mermaid source exceeds the size limit" }))
    : Effect.tryPromise({
        try: () => source.trimStart().toLowerCase().startsWith("eventmodeling")
          ? Promise.resolve(renderEventModel(source))
          : renderMermaid(source, {
          bg: DIAGRAM_BACKGROUND,
          fg: "#fafafa",
          line: "#71717a",
          accent: "#60a5fa",
          muted: "#a1a1aa",
          surface: "#18181b",
          border: "#52525b",
          font: DIAGRAM_FONT,
          padding: 48,
          fontSize: 15,
          edgeFontSize: 13,
          lineWidth: 1.25,
          }),
        catch: (cause) => new MermaidRenderError({ diagram, cause }),
      })

const pngFromSvg = (svg: string, diagram: number): Effect.Effect<Uint8Array, MermaidRenderError> =>
  Effect.try({
    try: () => {
      // beautiful-mermaid emits browser CSS custom properties. resvg does not
      // consistently resolve those properties in SVG presentation attributes,
      // which can make node fills fall back to black.
      const rasterSvg = resolveSvgRasterColors(svg)
      const font = { fontFiles: [DIAGRAM_FONT_FILE], loadSystemFonts: false, defaultFontFamily: DIAGRAM_FONT }
      const natural = new Resvg(rasterSvg, { background: DIAGRAM_BACKGROUND, font, logLevel: "off" })
      const naturalLongEdge = Math.max(natural.width, natural.height)
      const scale = Math.min(
        MAX_MERMAID_PNG_DIMENSION / naturalLongEdge,
        Math.max(MERMAID_RENDER_SCALE, MIN_MERMAID_PNG_LONG_EDGE / naturalLongEdge),
      )
      const png = new Resvg(rasterSvg, {
        background: DIAGRAM_BACKGROUND,
        font,
        fitTo: { mode: "zoom", value: scale },
        textRendering: 2,
        imageRendering: 0,
        logLevel: "off",
      }).render().asPng()
      if (png.byteLength > MAX_MERMAID_PNG_BYTES) {
        throw new Error("Rendered Mermaid PNG exceeds the size limit")
      }
      return new Uint8Array(png)
    },
    catch: (cause) => new MermaidRenderError({ diagram, cause }),
  })

/** Replace completed Mermaid fences with high-resolution PNG documents. */
export const renderTelegramMermaid = (text: string): Effect.Effect<TelegramRenderedMermaid> =>
  Effect.gen(function* () {
    const segments = mermaidSegments(text)
    let diagram = 0
    const rendered: string[] = []
    const media: MermaidMediaArtifact[] = []

    for (const segment of segments) {
      if (segment.type === "text") {
        rendered.push(segment.value)
        continue
      }
      diagram += 1
      if (diagram > MAX_MERMAID_BLOCKS) {
        rendered.push(segment.raw)
        continue
      }
      const output = yield* renderDiagram(segment.source, diagram).pipe(
        Effect.flatMap((svg) => pngFromSvg(svg, diagram)),
        Effect.tapCause((cause) =>
          logBoundary("telegram/mermaid", "mermaid-renderer", "mermaid PNG rendering failed")(cause),
        ),
        Effect.option,
      )
      if (Option.isNone(output)) {
        rendered.push(segment.raw)
        continue
      }
      const name = `diagram-${diagram}.png`
      media.push({
        key: `mermaid:${diagram}:${checksum(segment.source)}`,
        name,
        mime: "image/png",
        bytes: output.value,
        delivery: "document",
      })
      rendered.push(`[${name}]`)
    }

    return { text: rendered.join("").trim(), media }
  })

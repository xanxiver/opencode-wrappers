import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mermaidSegments, renderTelegramMermaid, resolveSvgRasterColors } from "../src/telegram/mermaid.js"

const pngDimensions = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

describe("mermaidSegments", () => {
  test("extracts completed backtick and tilde Mermaid fences", () => {
    const segments = mermaidSegments([
      "Before\n",
      "```Mermaid\nflowchart TD\nA --> B\n```\n",
      "Between\n",
      "~~~~ mermaid\ngraph LR\nC --> D\n~~~~\n",
      "After",
    ].join(""))

    expect(segments).toHaveLength(5)
    expect(segments[1]).toMatchObject({ type: "mermaid", source: "flowchart TD\nA --> B" })
    expect(segments[3]).toMatchObject({ type: "mermaid", source: "graph LR\nC --> D" })
  })

  test("preserves incomplete and ordinary code fences", () => {
    const text = "```ts\nconst mermaid = true\n```\n```mermaid\ngraph TD\nA --> B"
    expect(mermaidSegments(text)).toEqual([{ type: "text", value: text }])
  })

  test("accepts the diagram declaration on the opening-fence line", () => {
    const multiline = "```mermaid sequenceDiagram\nAlice->>Bob: Hello\n```"
    const inline = "```mermaid sequenceDiagram Alice->>Bob: Hello ```"

    expect(mermaidSegments(multiline)[0]).toMatchObject({
      type: "mermaid",
      source: "sequenceDiagram\nAlice->>Bob: Hello",
    })
    expect(mermaidSegments(inline)[0]).toMatchObject({
      type: "mermaid",
      source: "sequenceDiagram Alice->>Bob: Hello",
    })
  })

  test("extracts Mermaid embedded in the middle of an output line", () => {
    const text = "Before: ```mermaid sequenceDiagram\nAlice->>Bob: Hello\n``` after."
    const segments = mermaidSegments(text)

    expect(segments).toEqual([
      { type: "text", value: "Before: " },
      {
        type: "mermaid",
        raw: "```mermaid sequenceDiagram\nAlice->>Bob: Hello\n```",
        source: "sequenceDiagram\nAlice->>Bob: Hello",
      },
      { type: "text", value: " after." },
    ])
  })
})

describe("resolveSvgRasterColors", () => {
  test("replaces browser CSS variables used by Mermaid node boxes", () => {
    const svg = '<rect fill="var(--_node-fill)" stroke="var(--_node-stroke)"/><text fill="var(--_text)">Ready</text>'

    expect(resolveSvgRasterColors(svg)).toBe(
      '<rect fill="#18181b" stroke="#52525b"/><text fill="#fafafa">Ready</text>',
    )
  })

  test("keeps the recommended Geist font in rasterized Mermaid SVG", () => {
    const svg = '<text font-family="Geist">Ready</text>'

    expect(resolveSvgRasterColors(svg)).toContain('font-family="Geist"')
  })
})

describe("renderTelegramMermaid", () => {
  test("renders Mermaid as a high-resolution PNG document", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid(
      "Before <tag>\n```mermaid\nflowchart TD\nA[Prompt] --> B[Telegram]\n```\nAfter & done",
    ))

    expect(result.text).toContain("Before <tag>")
    expect(result.text).toContain("[diagram-1.png]")
    expect(result.text).toContain("After & done")
    expect(result.text).not.toContain("```mermaid")
    expect(result.media).toHaveLength(1)
    expect(result.media[0]?.mime).toBe("image/png")
    expect(result.media[0]?.delivery).toBe("document")
    expect([...result.media[0]?.bytes.slice(0, 8) ?? []]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const dimensions = pngDimensions(result.media[0]?.bytes ?? new Uint8Array())
    expect(Math.max(dimensions.width, dimensions.height)).toBeGreaterThanOrEqual(1920)
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
  })

  test("renders a sequence diagram declared beside the opening fence", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid(
      "```mermaid sequenceDiagram\nAlice->>Bob: Hello\n```",
    ))

    expect(result.text).toBe("[diagram-1.png]")
    expect(result.text).not.toContain("```mermaid")
    expect(result.media).toHaveLength(1)
  })

  test("renders a state diagram as a high-resolution PNG document", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid([
      "State lifecycle:\n",
      "```mermaid\n",
      "stateDiagram-v2\n",
      "  [*] --> Idle\n",
      "  Idle --> Active: start\n",
      "  Active --> Idle: stop\n",
      "  Active --> [*]: finish\n",
      "```\n",
      "Lifecycle complete.",
    ].join("")))

    expect(result.text).toBe("State lifecycle:\n[diagram-1.png]\nLifecycle complete.")
    expect(result.media).toHaveLength(1)
    expect(result.media[0]?.mime).toBe("image/png")
    expect(result.media[0]?.delivery).toBe("document")
    expect([...result.media[0]?.bytes.slice(0, 8) ?? []]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const dimensions = pngDimensions(result.media[0]?.bytes ?? new Uint8Array())
    expect(Math.max(dimensions.width, dimensions.height)).toBeGreaterThanOrEqual(1920)
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
  })

  test("renders aliased and composite state diagrams", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid([
      "```mermaid stateDiagram-v2\n",
      "direction LR\n",
      "state \"Active workflow\" as Active {\n",
      "  [*] --> Waiting\n",
      "  Waiting --> Processing: submit\n",
      "  Processing --> [*]: complete\n",
      "}\n",
      "[*] --> Active\n",
      "Active --> [*]\n",
      "```",
    ].join("")))

    expect(result.text).toBe("[diagram-1.png]")
    expect(result.media).toHaveLength(1)
    expect(result.media[0]?.bytes.length).toBeGreaterThan(1_000)
    const dimensions = pngDimensions(result.media[0]?.bytes ?? new Uint8Array())
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
  })

  test("renders the legacy stateDiagram declaration", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid(
      "```mermaid\nstateDiagram\n[*] --> First\nFirst --> Second\n```",
    ))

    expect(result.text).toBe("[diagram-1.png]")
    expect(result.media).toHaveLength(1)
  })

  test("renders an event modeling timeline as a high-resolution PNG document", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid([
      "Order flow:\n",
      "```mermaid\n",
      "eventmodeling\n",
      "tf 01 ui CartUI\n",
      "tf 02 cmd AddItem\n",
      "tf 03 evt ItemAdded\n",
      "tf 04 rmo ActiveCart\n",
      "```\n",
      "Flow complete.",
    ].join("")))

    expect(result.text).toBe("Order flow:\n[diagram-1.png]\nFlow complete.")
    expect(result.media).toHaveLength(1)
    expect(result.media[0]?.mime).toBe("image/png")
    expect(result.media[0]?.delivery).toBe("document")
    expect([...result.media[0]?.bytes.slice(0, 8) ?? []]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const dimensions = pngDimensions(result.media[0]?.bytes ?? new Uint8Array())
    expect(Math.max(dimensions.width, dimensions.height)).toBeGreaterThanOrEqual(1920)
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
  })

  test("renders event modeling namespaces, reset frames, relations, and data", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid([
      "```mermaid eventmodeling\n",
      "timeframe 01 ui Shop.CartUI\n",
      "timeframe 02 command Shop.AddItem [[AddItemData]]\n",
      "timeframe 03 event Shop.ItemAdded { sku: ABC, quantity: 1 }\n",
      "resetframe 04 event Shop.ItemAdded\n",
      "timeframe 05 processor Inventory.ReservationProcessor ->> 03\n",
      "timeframe 06 readmodel Shop.ActiveCart ->> 03 ->> 04\n",
      "data AddItemData `json`{\n",
      "  \"sku\": \"ABC\",\n",
      "  \"quantity\": 1\n",
      "}\n",
      "```",
    ].join("")))

    expect(result.text).toBe("[diagram-1.png]")
    expect(result.media).toHaveLength(1)
    expect(result.media[0]?.bytes.length).toBeGreaterThan(1_000)
    const dimensions = pngDimensions(result.media[0]?.bytes ?? new Uint8Array())
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
  })

  test("renders wide sequence diagrams as zoomable PNG documents", async () => {
    const participants = Array.from({ length: 12 }, (_, index) => `participant P${index} as Service${index}`).join("\n")
    const messages = Array.from({ length: 18 }, (_, index) => `P${index % 11}->>P${(index + 1) % 12}: Request ${index}`).join("\n")
    const result = await Effect.runPromise(renderTelegramMermaid(
      `Before\n\`\`\`mermaid\nsequenceDiagram\n${participants}\n${messages}\n\`\`\`\nAfter`,
    ))

    expect(result.text).toContain("[diagram-1.png]")
    expect(result.text).not.toContain("```mermaid")
    expect(result.media[0]?.bytes.length).toBeGreaterThan(1_000)
    const dimensions = pngDimensions(result.media[0]?.bytes ?? new Uint8Array())
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
  })

  test("keeps the source and plain delivery when rendering fails", async () => {
    const text = "```mermaid\nnot-a-supported-diagram\n```"
    const result = await Effect.runPromise(renderTelegramMermaid(text))
    expect(result).toEqual({ text, media: [] })
  })

  test("renders more than one Mermaid fence", async () => {
    const result = await Effect.runPromise(renderTelegramMermaid(
      "```mermaid\ngraph LR\nA --> B\n```\nthen\n```mermaid\nsequenceDiagram\nA->>B: Hi\n```",
    ))
    expect(result.media).toHaveLength(2)
    expect(result.text).toContain("[diagram-1.png]")
    expect(result.text).toContain("[diagram-2.png]")
  })

  test("keeps oversized Mermaid source when it cannot be rendered", async () => {
    const text = `Before\n\`\`\`mermaid\ngraph TD\nA[${"x".repeat(100_001)}]\n\`\`\`\nAfter`
    const result = await Effect.runPromise(renderTelegramMermaid(text))

    expect(result).toEqual({ text, media: [] })
  })
})

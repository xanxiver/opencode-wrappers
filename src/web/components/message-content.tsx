import { Effect, Fiber } from "effect"
import { For, Show, createSignal, onCleanup, type JSX } from "solid-js"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { Portal } from "solid-js/web"
import { AppViewModelError, type AppEffectRunner } from "../state/api-client"

type Block =
  | { readonly kind: "paragraph" | "heading"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly { readonly text: string; readonly level: number; readonly ordered: boolean }[] }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "table"; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "code"; readonly text: string; readonly language: string }

const blocks = (text: string): readonly Block[] => {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  const result: Block[] = []
  let paragraph: string[] = []
  let list: { text: string; level: number; ordered: boolean }[] = []
  let code: string[] | undefined
  let language = ""
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) result.push({ kind: "paragraph", text: paragraph.join("\n") })
    paragraph = []
  }
  const flushList = () => {
    if (list.length > 0) result.push({ kind: "list", items: list })
    list = []
  }
  const flushQuote = () => {
    if (quote.length > 0) result.push({ kind: "quote", text: quote.join("\n") })
    quote = []
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (code !== undefined) {
      if (line.startsWith("```")) {
        result.push({ kind: "code", text: code.join("\n"), language })
        code = undefined
        language = ""
      } else code.push(line)
      continue
    }
    if (line.startsWith("```")) {
      flushParagraph()
      flushList()
      code = []
      language = line.slice(3).trim()
      continue
    }
    if (line.trim() === "") {
      flushParagraph()
      flushList()
      flushQuote()
      continue
    }
    const quoteLine = /^>\s?(.*)$/.exec(line)
    if (quoteLine !== null) { flushParagraph(); flushList(); quote.push(quoteLine[1]); continue }
    const nextLine = lines[lineIndex + 1]
    const tableSeparator = nextLine !== undefined && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(nextLine)
    if (tableSeparator && line.includes("|")) {
      flushParagraph(); flushList(); flushQuote()
      const headers = line.split("|").map((cell) => cell.trim()).filter(Boolean)
      const rows: string[][] = []
      lineIndex += 2
      while (lineIndex < lines.length && lines[lineIndex].includes("|")) {
        rows.push(lines[lineIndex].split("|").map((cell) => cell.trim()).filter(Boolean)); lineIndex++
      }
      lineIndex--
      result.push({ kind: "table", headers, rows })
      continue
    }
    const listItem = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line)
    if (listItem !== null) {
      flushParagraph()
      list.push({ text: listItem[3], level: Math.floor(listItem[1].length / 2), ordered: /^\d/.test(listItem[2]) })
      continue
    }
    flushList()
    const heading = /^#{1,3}\s+(.+)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      result.push({ kind: "heading", text: heading[1] })
    } else paragraph.push(line)
  }
  if (code !== undefined) result.push({ kind: "code", text: code.join("\n"), language })
  flushQuote()
  flushParagraph()
  flushList()
  return result
}

type InlinePartValue = { readonly kind: "text" | "strong" | "code" | "link" | "image"; readonly value: string; readonly href?: string; readonly path?: string }

export const parseInlineParts = (text: string): readonly InlinePartValue[] => {
  const result: InlinePartValue[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|!\[[^\]]*\]\((?:file:\/\/|\/|\.\.?\/)[^\s)]+\)|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\[[^\]]+\]\((?:file:\/\/|\/|\.\.?\/)[^\s)]+\)|https?:\/\/[^\s<]+|(?:file:\/\/|\/|\.\.?\/)[^\s<>'"`]+?\.(?:png|jpe?g|gif|webp))/gi
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const rawValue = match[0]
    const index = match.index ?? 0
    if (index > cursor) result.push({ kind: "text", value: text.slice(cursor, index) })
    const value = rawValue.startsWith("http") ? rawValue.replace(/[.,;:!?]+$/, "") : rawValue
    if (value.startsWith("`")) result.push({ kind: "code", value: value.slice(1, -1) })
    else if (value.startsWith("**") || value.startsWith("__")) result.push({ kind: "strong", value: value.slice(2, -2) })
    else if (value.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(((?:file:\/\/|\/|\.\.?\/)[^\s)]+)\)$/.exec(value)
      if (image === null) result.push({ kind: "text", value })
      else result.push({ kind: "image", value: image[1] || image[2], path: image[2] })
    }
      else {
        const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(value)
        if (link !== null) result.push({ kind: "link", value: link[1], href: link[2] })
        else if (/^https?:\/\//.test(value)) result.push({ kind: "link", value, href: value })
        else {
          const localLink = /^\[([^\]]+)\]\(((?:file:\/\/|\/|\.\.?\/)[^\s)]+)\)$/.exec(value)
          const path = localLink?.[2] ?? value
          const label = localLink?.[1] ?? value
          if (/^(?:file:\/\/|\/|\.\.?\/).+\.(?:png|jpe?g|gif|webp)$/i.test(path)) result.push({ kind: "image", value: label, path })
          else result.push({ kind: "text", value })
        }
    }
    cursor = index + rawValue.length
    if (value.length < rawValue.length) result.push({ kind: "text", value: rawValue.slice(value.length) })
  }
  if (cursor < text.length) result.push({ kind: "text", value: text.slice(cursor) })
  return result
}

export function MessageContent(props: { readonly text: string; readonly streaming?: boolean; readonly directory?: string; readonly effectRunner: AppEffectRunner }) {
  return (
    <Show when={!props.streaming} fallback={<pre class="message-stream-text">{props.text}</pre>}>
      <div class="message-markdown">
        <For each={blocks(props.text)}>{(block) => {
          if (block.kind === "code") return <CodeBlock text={block.text} language={block.language} effectRunner={props.effectRunner} />
          if (block.kind === "quote") return <blockquote><For each={parseInlineParts(block.text)}>{(part) => <InlinePart part={part} directory={props.directory} />}</For></blockquote>
          if (block.kind === "table") return <div class="message-table-wrap"><table><thead><tr><For each={block.headers}>{(cell) => <th scope="col"><For each={parseInlineParts(cell)}>{(part) => <InlinePart part={part} directory={props.directory} />}</For></th>}</For></tr></thead><tbody><For each={block.rows}>{(row) => <tr><For each={row}>{(cell) => <td><For each={parseInlineParts(cell)}>{(part) => <InlinePart part={part} directory={props.directory} />}</For></td>}</For></tr>}</For></tbody></table></div>
          if (block.kind === "heading") return <h4><For each={parseInlineParts(block.text)}>{(part) => <InlinePart part={part} directory={props.directory} />}</For></h4>
          if (block.kind === "list") return <ListBlock items={block.items} directory={props.directory} />
          return <p><For each={parseInlineParts(block.text)}>{(part) => <InlinePart part={part} directory={props.directory} />}</For></p>
        }}</For>
      </div>
    </Show>
  )
}

function ListBlock(props: { readonly items: readonly { readonly text: string; readonly level: number; readonly ordered: boolean }[]; readonly directory?: string }) {
  type Item = { readonly text: string; readonly level: number; readonly ordered: boolean }
  const renderItems = (items: readonly Item[], level: number): JSX.Element[] => {
    const nodes: JSX.Element[] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      if (item.level !== level) continue
      let end = index + 1
      while (end < items.length && items[end].level > level) end++
      const children = items.slice(index + 1, end).map((child) => ({ ...child, level: child.level - level - 1 }))
      nodes.push(<li><For each={parseInlineParts(item.text)}>{(part) => <InlinePart part={part} directory={props.directory} />}</For>{children.length > 0 ? <ListBlock items={children} directory={props.directory} /> : undefined}</li>)
      index = end - 1
    }
    return nodes
  }
  const renderLists = (items: readonly Item[], level: number): JSX.Element[] => {
    const lists: JSX.Element[] = []
    const topLevel = items.map((item, index) => ({ item, index })).filter(({ item }) => item.level === level)
    for (let index = 0; index < topLevel.length;) {
      const start = topLevel[index].index
      const ordered = topLevel[index].item.ordered
      let next = index + 1
      while (next < topLevel.length && topLevel[next].item.ordered === ordered) next++
      const end = next < topLevel.length ? topLevel[next].index : items.length
      const group = items.slice(start, end)
      const content = renderItems(group, level)
      lists.push(ordered ? <ol><For each={content}>{(item) => item}</For></ol> : <ul><For each={content}>{(item) => item}</For></ul>)
      index = next
    }
    return lists
  }
  return <>{renderLists(props.items, 0)}</>
}

function CodeBlock(props: { readonly text: string; readonly language: string; readonly effectRunner: AppEffectRunner }) {
  const [copied, setCopied] = createSignal(false)
  let copyFiber: Fiber.Fiber<void> | undefined
  let copyGeneration = 0
  const copy = () => {
    const generation = ++copyGeneration
    if (copyFiber !== undefined) props.effectRunner.fork(Fiber.interrupt(copyFiber))
    copyFiber = props.effectRunner.run(Effect.tryPromise({
      try: () => navigator.clipboard.writeText(props.text),
      catch: (cause) => new AppViewModelError("copy code block", cause),
    }).pipe(
      Effect.tap(() => Effect.sync(() => setCopied(true))),
      Effect.andThen(Effect.sleep("1.4 seconds")),
      Effect.tap(() => Effect.sync(() => setCopied(false))),
      Effect.ensuring(Effect.sync(() => { if (copyGeneration === generation) copyFiber = undefined })),
    ), () => setCopied(false))
  }
  onCleanup(() => {
    copyGeneration += 1
    if (copyFiber !== undefined) props.effectRunner.fork(Fiber.interrupt(copyFiber))
  })
  return <div class="message-code-wrap">
    <div class="message-code-toolbar"><span>{props.language || "code"}</span><button class="message-code-copy" type="button" onClick={copy}>{copied() ? "Copied" : "Copy"}</button></div>
    <pre class="message-code" data-language={props.language || undefined}><code>{props.text}</code></pre>
  </div>
}

function InlinePart(props: { readonly part: ReturnType<typeof parseInlineParts>[number]; readonly directory?: string }) {
  const [warningOpen, setWarningOpen] = createSignal(false)
  const imagePath = () => props.part.path?.startsWith("file://") ? (() => { try { return decodeURIComponent(new URL(props.part.path).pathname) } catch { return props.part.path } })() : props.part.path
  const localImageHref = () => imagePath() === undefined
    ? undefined
    : `/api/images/local?path=${encodeURIComponent(imagePath() ?? "")}${props.directory === undefined ? "" : `&directory=${encodeURIComponent(props.directory)}`}`
  const openExternalLink = (event: MouseEvent) => {
    const href = props.part.href ?? localImageHref()
    if (href === undefined) return
    if (props.part.kind !== "link") return
    event.preventDefault()
    setWarningOpen(true)
  }
  const openLink = () => {
    const href = props.part.href
    if (href === undefined) return
    const tab = window.open(href, "_blank", "noopener,noreferrer")
    tab?.focus()
    setWarningOpen(false)
  }
  const content = (): JSX.Element => {
    if (props.part.kind === "strong") return <strong>{props.part.value}</strong>
    if (props.part.kind === "code") return <code class="message-inline-code">{props.part.value}</code>
    if (props.part.kind === "image") {
      return <a class="message-local-image" href={localImageHref()} target="_blank" rel="noopener noreferrer" onClick={openExternalLink}><img src={localImageHref()} alt={props.part.value} loading="lazy" /><span>{props.part.value}</span></a>
    }
    if (props.part.kind === "link") return <a href={props.part.href} target="_blank" rel="noopener noreferrer" onClick={openExternalLink}>{props.part.value}</a>
    return props.part.value
  }

  return <>
    {content()}
    <Dialog.Root open={warningOpen()} onOpenChange={(details) => setWarningOpen(details.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Open external link?</Dialog.Title>
              <Dialog.Description>This link opens outside Kissa in a new tab.</Dialog.Description>
            </Dialog.Header>
            <Dialog.Body>
              <div class="message-link-warning-url">{props.part.href}</div>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} variant="ghost" size="sm">Cancel</Button>} />
              <Button size="sm" onClick={openLink}>Open link</Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild={(triggerProps) => <Button {...triggerProps()} variant="ghost" size="sm" aria-label="Close link warning">Close</Button>} />
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  </>
}

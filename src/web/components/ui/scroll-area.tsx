import { ScrollArea as ArkScrollArea } from "@ark-ui/solid/scroll-area"
import type { ComponentProps } from "solid-js"
import { css } from "../../styled-system/css"

const styles = {
  root: css({ position: "relative", w: "full", h: "full", overflow: "hidden" }),
  viewport: css({ w: "full", h: "full", overflowX: "hidden", overflowY: "auto", scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }),
  content: css({ minH: "full" }),
  scrollbar: css({ position: "absolute", top: "2", right: "0", bottom: "2", display: "flex", justifyContent: "center", w: "4", touchAction: "none", userSelect: "none", '&[data-orientation="vertical"][data-overflow-y="false"]': { display: "none" } }),
  thumb: css({ w: "2.5", borderRadius: "full", bg: "var(--coffee-border-strong)", opacity: "0.8", transition: "opacity 120ms ease, background 120ms ease", _hover: { bg: "var(--coffee-accent)", opacity: "1" } }),
}

export const ScrollArea = {
  Root: (props: ComponentProps<typeof ArkScrollArea.Root>) => <ArkScrollArea.Root {...props} class={`${styles.root} ${props.class ?? ""}`} />,
  Viewport: (props: ComponentProps<typeof ArkScrollArea.Viewport>) => <ArkScrollArea.Viewport {...props} class={`${styles.viewport} ${props.class ?? ""}`} />,
  Content: (props: ComponentProps<typeof ArkScrollArea.Content>) => <ArkScrollArea.Content {...props} class={`${styles.content} ${props.class ?? ""}`} />,
  Scrollbar: (props: ComponentProps<typeof ArkScrollArea.Scrollbar>) => <ArkScrollArea.Scrollbar {...props} class={`${styles.scrollbar} ${props.class ?? ""}`} />,
  Thumb: (props: ComponentProps<typeof ArkScrollArea.Thumb>) => <ArkScrollArea.Thumb {...props} class={`${styles.thumb} ${props.class ?? ""}`} />,
}

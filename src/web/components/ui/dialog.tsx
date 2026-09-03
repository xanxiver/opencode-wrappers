import { Dialog as ArkDialog, useDialogContext } from "@ark-ui/solid/dialog"
import { ark } from "@ark-ui/solid/factory"
import type { ComponentProps } from "solid-js"
import { createStyleContext, styled } from "../../styled-system/jsx"
import { css } from "../../styled-system/css"
import { dialog } from "../../styled-system/recipes"

const { withRootProvider } = createStyleContext(dialog)
const StyledButton = styled(ark.button)
const styles = {
  backdrop: css({ position: "fixed", inset: "0", zIndex: "1399", bg: "var(--coffee-backdrop)", backdropFilter: "blur(10px)" }),
  positioner: css({ position: "fixed", inset: "0", zIndex: "1400", display: "grid", placeItems: "center", p: { base: "3", md: "4" } }),
  content: css({ position: "relative", w: "min(600px, calc(100vw - 24px))", maxH: "min(720px, calc(100dvh - 24px))", overflowY: "auto", display: "flex", flexDir: "column", gap: { base: "4", md: "5" }, p: { base: "4", md: "6" }, border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: { base: "xl", md: "2xl" }, bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)", boxShadow: "0 20px 50px var(--coffee-shadow)" }),
  header: css({ display: "flex", flexDir: "column", gap: "1.5", pr: "10" }),
  body: css({ display: "flex", flexDir: "column", gap: "4" }),
  footer: css({ display: "flex", justifyContent: "flex-end", gap: "2" }),
  title: css({ fontSize: "lg", fontWeight: "semibold", color: "var(--coffee-text)" }),
  description: css({ fontSize: "sm", color: "var(--coffee-text-muted)" }),
  close: css({ position: "absolute", top: { base: "3", md: "5" }, right: { base: "3", md: "5" }, color: "var(--coffee-text-muted)" }),
}

export const Dialog = {
  Root: withRootProvider(ArkDialog.Root, { defaultProps: () => ({ unmountOnExit: true, lazyMount: true }) }),
  Backdrop: (props: ComponentProps<typeof ArkDialog.Backdrop>) => <ArkDialog.Backdrop {...props} class={`${styles.backdrop} ${props.class ?? ""}`} />,
  Positioner: (props: ComponentProps<typeof ArkDialog.Positioner>) => <ArkDialog.Positioner {...props} class={`${styles.positioner} ${props.class ?? ""}`} />,
  Content: (props: ComponentProps<typeof ArkDialog.Content>) => <ArkDialog.Content {...props} class={`${styles.content} ${props.class ?? ""}`} />,
  Header: (props: ComponentProps<typeof ark.div>) => <ark.div {...props} class={`${styles.header} ${props.class ?? ""}`} />,
  Body: (props: ComponentProps<typeof ark.div>) => <ark.div {...props} class={`${styles.body} ${props.class ?? ""}`} />,
  Footer: (props: ComponentProps<typeof ark.div>) => <ark.div {...props} class={`${styles.footer} ${props.class ?? ""}`} />,
  Title: (props: ComponentProps<typeof ArkDialog.Title>) => <ArkDialog.Title {...props} class={`${styles.title} ${props.class ?? ""}`} />,
  Description: (props: ComponentProps<typeof ArkDialog.Description>) => <ArkDialog.Description {...props} class={`${styles.description} ${props.class ?? ""}`} />,
  CloseTrigger: (props: ComponentProps<typeof ArkDialog.CloseTrigger>) => <ArkDialog.CloseTrigger {...props} class={`${styles.close} ${props.class ?? ""}`} />,
  ActionTrigger: (props: ComponentProps<typeof StyledButton>) => {
    const context = useDialogContext()
    return <StyledButton {...props} onClick={() => context().setOpen(false)} />
  },
}

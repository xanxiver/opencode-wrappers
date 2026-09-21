import { Combobox as ArkCombobox } from "@ark-ui/solid/combobox"
import { ark } from "@ark-ui/solid/factory"
import { ChevronsUpDown, X } from "lucide-solid"
import type { ComponentProps } from "solid-js"
import { createStyleContext } from "../../styled-system/jsx"
import { css } from "../../styled-system/css"
import { type ComboboxVariantProps, combobox } from "../../styled-system/recipes"
import type { HTMLStyledProps } from "../../styled-system/types"

const { withProvider, withContext } = createStyleContext(combobox)
type RootProps = HTMLStyledProps<"div"> & ComboboxVariantProps
// SAFETY: withProvider preserves the Ark root component contract while adding styled root props.
const Root = withProvider(ArkCombobox.Root, "root", { defaultProps: () => ({ positioning: { sameWidth: false } }) }) as ArkCombobox.RootComponent<RootProps>
const StyledContent = withContext(ArkCombobox.Content, "content")
const StyledControl = withContext(ArkCombobox.Control, "control")
const StyledInput = withContext(ArkCombobox.Input, "input")
const StyledTrigger = withContext(ArkCombobox.Trigger, "trigger")
const StyledClearTrigger = withContext(ArkCombobox.ClearTrigger, "clearTrigger")
const StyledPositioner = withContext(ArkCombobox.Positioner, "positioner")
const contentClass = css({ w: "var(--reference-width)", maxW: "calc(100vw - 24px)", maxH: "min(420px, var(--available-height))", overflowX: "hidden", overflowY: "auto", overscrollBehavior: "contain", scrollbarGutter: "stable", p: "1.5", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "xl", bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)", boxShadow: "0 14px 36px var(--coffee-shadow)" })
const controlClass = css({ position: "relative", w: "full" })
const inputClass = css({ w: "full", minH: "11", px: "3", pr: "20", border: "1px solid", borderColor: "var(--coffee-border-strong)", borderRadius: "lg", bg: "var(--coffee-canvas)", color: "var(--coffee-text)", outline: "none", _focusVisible: { borderColor: "var(--coffee-accent)", boxShadow: "0 0 0 2px var(--coffee-glow)" }, _placeholder: { color: "var(--coffee-text-muted)" } })
const indicatorGroupClass = css({ position: "absolute", insetBlock: "0", right: "1", display: "flex", alignItems: "center", gap: "0.5" })
const indicatorButtonClass = css({ position: "static", display: "grid", placeItems: "center", w: "8", h: "8", p: "0", border: "0", borderRadius: "md", bg: "transparent", color: "var(--coffee-text-muted)", cursor: "pointer", _hover: { bg: "var(--coffee-surface)", color: "var(--coffee-text)" }, "& svg": { w: "4", h: "4" } })
const positionerClass = css({ zIndex: "1500!" })

export const Combobox = {
  Root,
  Label: withContext(ArkCombobox.Label, "label"),
  Control: (props: ComponentProps<typeof StyledControl>) => <StyledControl {...props} class={`${controlClass} ${props.class ?? ""}`} />,
  Input: (props: ComponentProps<typeof StyledInput>) => <StyledInput {...props} class={`${inputClass} ${props.class ?? ""}`} />,
  IndicatorGroup: (props: ComponentProps<typeof ark.div>) => <ark.div {...props} class={`${indicatorGroupClass} ${props.class ?? ""}`} />,
  Trigger: (props: ComponentProps<typeof StyledTrigger>) => <StyledTrigger {...props} class={`${indicatorButtonClass} ${props.class ?? ""}`}>{props.children ?? <ChevronsUpDown />}</StyledTrigger>,
  ClearTrigger: (props: ComponentProps<typeof StyledClearTrigger>) => <StyledClearTrigger {...props} class={`${indicatorButtonClass} ${props.class ?? ""}`}>{props.children ?? <X />}</StyledClearTrigger>,
  Positioner: (props: ComponentProps<typeof StyledPositioner>) => <StyledPositioner {...props} class={`${positionerClass} ${props.class ?? ""}`} />,
  Content: (props: ComponentProps<typeof StyledContent>) => <StyledContent {...props} class={`${contentClass} ${props.class ?? ""}`} />,
  Empty: ArkCombobox.Empty,
  Item: withContext(ArkCombobox.Item, "item"),
  ItemGroup: withContext(ArkCombobox.ItemGroup, "itemGroup"),
  ItemGroupLabel: withContext(ArkCombobox.ItemGroupLabel, "itemGroupLabel"),
  ItemText: withContext(ArkCombobox.ItemText, "itemText"),
  ItemIndicator: withContext(ArkCombobox.ItemIndicator, "itemIndicator"),
}

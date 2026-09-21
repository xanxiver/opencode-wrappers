import { useListCollection } from "@ark-ui/solid/collection"
import { useFilter } from "@ark-ui/solid/locale"
import { For, Show, createEffect, createSignal } from "solid-js"
import { Portal } from "solid-js/web"
import { Check } from "lucide-solid"
import { css } from "../styled-system/css"
import { Combobox } from "./ui/combobox"

export interface PickerOption {
  readonly label: string
  readonly value: string
  readonly detail?: string
  readonly group?: string
  readonly status?: string
}

interface PickerGroup {
  readonly label: string
  readonly items: readonly PickerOption[]
}

const styles = {
  optionItem: css({ position: "relative", h: "auto!", minH: "14", display: "flex", alignItems: "flex-start", gap: "2.5", px: "3", py: "2.5", borderRadius: "md", color: "var(--coffee-text)", cursor: "pointer", transition: "background 160ms ease, color 160ms ease, transform 160ms ease", _hover: { bg: "var(--coffee-surface)", color: "var(--coffee-text)" }, _active: { transform: "scale(0.99)" }, _focusVisible: { outline: "2px solid", outlineColor: "var(--coffee-accent)", outlineOffset: "-2px" }, "&[data-highlighted]": { bg: "var(--coffee-surface)", color: "var(--coffee-text)" }, "&[data-state=checked]": { bg: "var(--coffee-surface-raised)", color: "var(--coffee-text)" }, "&[data-disabled]": { opacity: "0.45", cursor: "not-allowed" } }),
  optionDefault: css({ color: "var(--coffee-text-muted)", "&[data-state=checked]": { color: "var(--coffee-text)" } }),
  optionCopy: css({ minW: "0", maxW: "full", display: "flex", flex: "1", flexDir: "column", alignItems: "flex-start", gap: "0.5", overflow: "hidden" }),
  optionLabel: css({ w: "full", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "sm", fontWeight: "medium", lineHeight: "1.35" }),
  optionDetail: css({ w: "full", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--coffee-text-muted)", fontFamily: "var(--font-mono)", fontSize: "xs", lineHeight: "1.35" }),
  optionGroup: css({ position: "sticky", top: "0", zIndex: "1", minH: "8!", px: "3", py: "2", borderBottom: "1px solid", borderColor: "var(--coffee-border)", bg: "var(--coffee-surface-raised)", color: "var(--coffee-accent-strong)", fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: "semibold", letterSpacing: "0.08em", lineHeight: "1.2", textTransform: "uppercase" }),
  optionActive: css({ color: "var(--coffee-accent-strong)", fontSize: "10px", fontWeight: "medium", lineHeight: "1.35" }),
  optionStatus: css({ color: "var(--coffee-text-muted)", fontSize: "10px", lineHeight: "1.35", textWrap: "pretty" }),
  optionCheck: css({ mt: "0.5", ml: "auto", display: "grid", placeItems: "center", w: "6", h: "6", flexShrink: "0", borderRadius: "full", bg: "var(--coffee-accent)", color: "var(--coffee-on-accent)" }),
  empty: css({ display: "flex", flexDir: "column", gap: "1", p: "5", color: "var(--coffee-text-muted)", fontSize: "sm", lineHeight: "1.5", textAlign: "center" }),
  loadingRows: css({ display: "flex", flexDir: "column", gap: "2", p: "2" }),
  loadingRow: css({ display: "flex", flexDir: "column", gap: "1.5", p: "2", borderRadius: "md", bg: "var(--coffee-surface)", animation: "pulse 1.4s ease-in-out infinite", "& span": { display: "block", h: "2", borderRadius: "full", bg: "var(--coffee-border-strong)" }, "& span:first-child": { w: "58%" }, "& span:nth-child(2)": { w: "82%", h: "1.5" }, "& span:last-child": { w: "32%", h: "1.5" } }),
}

export function PickerCombobox(props: {
  readonly label: string
  readonly placeholder: string
  readonly value: string
  readonly items: readonly PickerOption[]
  readonly onChange: (value: string) => void
  readonly groupByDetail?: boolean
  readonly groupBy?: "detail" | "group"
  readonly activeValue?: string
  readonly disabled?: boolean
  readonly autoFocus?: boolean
  readonly loading?: boolean
}) {
  const localeFilter = useFilter({ sensitivity: "base" })
  const selectedLabel = () => props.items.find((item) => item.value === props.value)?.label ?? ""
  const [inputValue, setInputValue] = createSignal(selectedLabel())
  let lastValue = props.value
  let inputElement: HTMLInputElement | undefined
  const matchesPickerText = (itemText: string, filterText: string, item: PickerOption): boolean =>
    localeFilter().contains(`${itemText} ${item.label} ${item.value} ${item.detail ?? ""} ${item.group ?? ""}`, filterText)
  const { collection, filter, set } = useListCollection<PickerOption>({
    initialItems: props.items,
    filter: matchesPickerText,
  })

  createEffect(() => set([...props.items]))
  createEffect(() => {
    const value = props.value
    if (value === lastValue) return
    lastValue = value
    setInputValue(props.items.find((item) => item.value === value)?.label ?? "")
  })
  createEffect(() => {
    if (props.autoFocus) queueMicrotask(() => inputElement?.focus())
  })

  const handleInputValueChange = (value: string) => {
    setInputValue(value)
    filter(value)
  }

  const handleValueChange = (value: string) => {
    const item = props.items.find((option) => option.value === value)
    setInputValue(item?.label ?? "")
    props.onChange(value)
  }

  const groups = (): readonly PickerGroup[] => {
    const grouped = new Map<string, PickerOption[]>()
    for (const item of collection().items) {
      const label = props.groupBy === "group" ? item.group ?? "Other" : item.detail ?? "Other"
      const group = grouped.get(label)
      if (group === undefined) grouped.set(label, [item])
      else group.push(item)
    }
    return [...grouped].map(([label, items]) => ({ label, items }))
  }

  const renderItem = (item: PickerOption) => (
    <Combobox.Item item={item} class={`${styles.optionItem} ${item.value.length === 0 ? styles.optionDefault : ""}`}>
      <span class={styles.optionCopy}>
        <Combobox.ItemText class={styles.optionLabel}>{item.label}</Combobox.ItemText>
        <Show when={item.detail}><span class={styles.optionDetail}>{item.detail}</span></Show>
        <Show when={item.status}><span class={styles.optionStatus}>{item.status}</span></Show>
        <Show when={props.activeValue === item.value}><span class={styles.optionActive}>Active</span></Show>
      </span>
      <Show when={props.value === item.value}><span class={styles.optionCheck}><Check size={14} aria-hidden="true" /></span></Show>
    </Combobox.Item>
  )

  return (
    <Combobox.Root
      collection={collection()}
      value={props.value.length > 0 ? [props.value] : []}
      inputValue={inputValue()}
      disabled={props.disabled}
      positioning={{ placement: "bottom-start", strategy: "fixed", flip: true, gutter: 6, sameWidth: true }}
      openOnClick
      onInputValueChange={(event) => handleInputValueChange(event.inputValue)}
      onValueChange={(event) => handleValueChange(event.value[0] ?? "")}
    >
      <Combobox.Label>{props.label}</Combobox.Label>
      <Combobox.Control>
        <Combobox.Input ref={(element) => { inputElement = element }} placeholder={props.placeholder} />
        <Combobox.IndicatorGroup>
          <Combobox.ClearTrigger />
          <Combobox.Trigger />
        </Combobox.IndicatorGroup>
      </Combobox.Control>
      <Portal>
        <Combobox.Positioner>
          <Combobox.Content>
            <Show when={props.loading} fallback={<>
              <Combobox.Empty class={styles.empty}>{inputValue().length > 0 ? <><strong>No matches found</strong><span>Try a shorter search.</span></> : <><strong>No options available</strong><span>There is nothing to choose here yet.</span></>}</Combobox.Empty>
               <Show when={props.groupByDetail || props.groupBy !== undefined} fallback={<For each={collection().items}>{renderItem}</For>}>
                <For each={groups()}>{(group) => <Combobox.ItemGroup id={group.label}><Combobox.ItemGroupLabel class={styles.optionGroup}>{group.label}</Combobox.ItemGroupLabel><For each={group.items}>{renderItem}</For></Combobox.ItemGroup>}</For>
              </Show>
            </>}>
              <div aria-label="Loading options" class={styles.loadingRows}><For each={[1, 2, 3]}>{() => <div class={styles.loadingRow}><span /><span /><span /></div>}</For></div>
            </Show>
          </Combobox.Content>
        </Combobox.Positioner>
      </Portal>
    </Combobox.Root>
  )
}

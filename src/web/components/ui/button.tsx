import { ark } from "@ark-ui/solid/factory"
import { Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { styled } from "../../styled-system/jsx"
import { button } from "../../styled-system/recipes"
import { Spinner } from "./spinner"

const BaseButton = styled(ark.button, button)
export interface ButtonProps extends ComponentProps<typeof BaseButton> {
  readonly loading?: boolean
  readonly loadingText?: JSX.Element
}

export const Button = (props: ButtonProps) => {
  const [local, rest] = splitProps(props, ["loading", "loadingText", "children"])
  return <BaseButton type="button" {...rest} disabled={local.loading || rest.disabled} aria-busy={local.loading ? "true" : undefined}><Show when={local.loading} fallback={local.children}><Spinner size="sm" aria-hidden="true" />{local.loadingText ?? local.children}</Show></BaseButton>
}

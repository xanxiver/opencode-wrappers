import { ark } from "@ark-ui/solid/factory"
import { CircleAlert } from "lucide-solid"
import type { ComponentProps } from "solid-js"
import { createStyleContext } from "../../styled-system/jsx"
import { alert } from "../../styled-system/recipes"

const { withProvider, withContext } = createStyleContext(alert)
const StyledRoot = withProvider(ark.div, "root")
const StyledIndicator = withContext(ark.span, "icon")

export const Alert = {
  Root: (props: ComponentProps<typeof StyledRoot>) => <StyledRoot role="alert" aria-live="polite" {...props} />,
  Content: withContext(ark.div, "content"),
  Title: withContext(ark.h3, "title"),
  Description: withContext(ark.div, "description"),
  Indicator: (props: ComponentProps<typeof StyledIndicator>) => <StyledIndicator {...props}><CircleAlert /></StyledIndicator>,
}

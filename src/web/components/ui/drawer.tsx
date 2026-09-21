import { Dialog as ArkDialog } from "@ark-ui/solid/dialog"
import { ark } from "@ark-ui/solid/factory"
import { createStyleContext } from "../../styled-system/jsx"
import { drawer } from "../../styled-system/recipes"

const { withRootProvider, withContext } = createStyleContext(drawer)

export const Drawer = {
  Root: withRootProvider(ArkDialog.Root, { defaultProps: () => ({ unmountOnExit: true, lazyMount: true }) }),
  Backdrop: withContext(ArkDialog.Backdrop, "backdrop"),
  Positioner: withContext(ArkDialog.Positioner, "positioner"),
  Content: withContext(ArkDialog.Content, "content"),
  CloseTrigger: withContext(ArkDialog.CloseTrigger, "closeTrigger"),
  Title: withContext(ArkDialog.Title, "title"),
  Description: withContext(ArkDialog.Description, "description"),
  Header: withContext(ark.div, "header"),
  Body: withContext(ark.div, "body"),
  Footer: withContext(ark.div, "footer"),
}

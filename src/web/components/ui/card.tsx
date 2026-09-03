import { ark } from "@ark-ui/solid/factory"
import { createStyleContext } from "../../styled-system/jsx"
import { card } from "../../styled-system/recipes"

const { withProvider, withContext } = createStyleContext(card)

export const Card = withProvider(ark.div, "root")
export const CardHeader = withContext(ark.div, "header")
export const CardBody = withContext(ark.div, "body")
export const CardTitle = withContext(ark.h3, "title")
export const CardDescription = withContext(ark.div, "description")

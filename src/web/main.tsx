import { render } from "solid-js/web"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import App from "./App"
import { RegistryProvider } from "./state/atom-solid"
import "./index.css"

const root = document.getElementById("root")
if (root === null) throw new Error("web root element is missing")
render(() => <RegistryProvider><App /></RegistryProvider>, root)

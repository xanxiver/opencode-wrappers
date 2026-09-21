import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"

const RegistryContext = createContext<AtomRegistry.AtomRegistry>()

export function RegistryProvider(props: ParentProps) {
  const registry = AtomRegistry.make()
  onCleanup(() => registry.dispose())
  return <RegistryContext.Provider value={registry}>{props.children}</RegistryContext.Provider>
}

const useRegistry = (): AtomRegistry.AtomRegistry => {
  const registry = useContext(RegistryContext)
  if (registry === undefined) throw new Error("Atom registry is not available")
  return registry
}

export function useAtomValue<A>(atom: Atom.Atom<A>): Accessor<A> {
  const registry = useRegistry()
  const [value, setValue] = createSignal(registry.get(atom))
  const unsubscribe = registry.subscribe(atom, (next) => setValue(() => next), { immediate: true })
  onCleanup(unsubscribe)
  return value
}

export function useAtomRegistry(): AtomRegistry.AtomRegistry {
  return useRegistry()
}

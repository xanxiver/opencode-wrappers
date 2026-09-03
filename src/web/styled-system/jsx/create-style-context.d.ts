/* eslint-disable */
import type { SlotRecipeRuntimeFn, RecipeVariantProps } from '../types/recipe';
import type { JsxHTMLProps, JsxStyleProps, Assign } from '../types/system-types';
import type { JsxFactoryOptions, DataAttrs, MaybeAccessor, AsProps } from '../types/jsx';
import type { Component, JSX, ComponentProps } from 'solid-js'

interface UnstyledProps {
  unstyled?: boolean | undefined
}

interface WithProviderOptions<P> {
  defaultProps?: MaybeAccessor<Partial<P> & DataAttrs> | undefined
}

type ElementType = keyof JSX.IntrinsicElements | Component<any>

type SvaFn<S extends string = any> = SlotRecipeRuntimeFn<S, any>
interface SlotRecipeFn {
  __type: any
  __slot: string
  (props?: any): any
}
type SlotRecipe = SvaFn | SlotRecipeFn

type InferSlot<R extends SlotRecipe> = R extends SlotRecipeFn
  ? R['__slot']
  : R extends SvaFn<infer S>
    ? S
    : never

type StyleContextProvider<T extends ElementType, R extends SlotRecipe> = Component<
  JsxHTMLProps<ComponentProps<T> & UnstyledProps & AsProps, Assign<RecipeVariantProps<R>, JsxStyleProps>>
>

type StyleContextRootProvider<T extends ElementType, R extends SlotRecipe> = Component<
  ComponentProps<T> & UnstyledProps & RecipeVariantProps<R>
>

type StyleContextConsumer<T extends ElementType> = Component<
  JsxHTMLProps<ComponentProps<T> & UnstyledProps & AsProps, JsxStyleProps>
>

export interface StyleContext<R extends SlotRecipe> {
  withRootProvider: <T extends ElementType>(
    Component: T,
    options?: WithProviderOptions<ComponentProps<T>> | undefined
  ) => StyleContextRootProvider<T, R>
  withProvider: <T extends ElementType>(
    Component: T,
    slot: InferSlot<R>,
    options?: JsxFactoryOptions<ComponentProps<T>> | undefined
  ) => StyleContextProvider<T, R>
  withContext: <T extends ElementType>(
    Component: T,
    slot: InferSlot<R>,
    options?: JsxFactoryOptions<ComponentProps<T>> | undefined
  ) => StyleContextConsumer<T>
}

export declare function createStyleContext<R extends SlotRecipe>(recipe: R): StyleContext<R>
import { createMemo, mergeProps, splitProps } from 'solid-js'
import { Dynamic, createComponent } from 'solid-js/web'
import { css, cx, cva } from '../css/index.mjs';
import { normalizeHTMLProps } from '../helpers.mjs';
import { composeCvaFn, composeShouldForwardProps, defaultShouldForwardProp, getDisplayName } from './factory-helper.mjs';
import { isCssProperty } from './is-valid-prop.mjs';

function styledFn(element, configOrCva = {}, options = {}) {
  const cvaFn =
    configOrCva.__cva__ || configOrCva.__recipe__
      ? configOrCva
      : cva(configOrCva)

  const forwardFn = options.shouldForwardProp || defaultShouldForwardProp
  const shouldForwardProp = (prop) => {
    if (options.forwardProps?.includes(prop)) return true
    return forwardFn(prop, cvaFn.variantKeys)
  }

  const getDefaultProps = () => {
    const baseDefaults = options.dataAttr && configOrCva.__name__
      ? { 'data-recipe': configOrCva.__name__ }
      : {}
    const defaults = typeof options.defaultProps === 'function'
      ? options.defaultProps()
      : options.defaultProps
    return Object.assign(baseDefaults, defaults)
  }

  const __cvaFn__ = composeCvaFn(element.__cva__, cvaFn)
  const __shouldForwardProps__ = composeShouldForwardProps(
    element,
    shouldForwardProp
  )

  const StyledComponent = (props) => {
    const mergedProps = mergeProps(
      { as: element.__base__ || element },
      getDefaultProps(),
      props
    )

    const [localProps, restProps] = splitProps(mergedProps, [
      'as',
      'unstyled',
      'class',
      'className',
    ])

    const [htmlProps, aProps] = splitProps(restProps, normalizeHTMLProps.keys)

    const forwardedKeys = createMemo(() => {
      const keys = Object.keys(aProps)
      return keys.filter((prop) => __shouldForwardProps__(prop))
    })

    const [forwardedProps, variantProps, bProps] = splitProps(aProps, forwardedKeys(), __cvaFn__.variantKeys)

    const cssPropKeys = createMemo(() => {
      const keys = Object.keys(bProps)
      return keys.filter((prop) => isCssProperty(prop))
    })

    const [styleProps, elementProps] = splitProps(bProps, cssPropKeys())

    function recipeClass() {
      const { css: cssStyles, ...propStyles } = styleProps
      const compoundVariantStyles =
        __cvaFn__.__getCompoundVariantCss__?.(variantProps)
      return cx(
        __cvaFn__(variantProps, false),
        css(compoundVariantStyles, propStyles, cssStyles),
        localProps.class,
        localProps.className
      )
    }

    function cvaClass() {
      const { css: cssStyles, ...propStyles } = styleProps
      const cvaStyles = __cvaFn__.raw(variantProps)
      return cx(
        css(cvaStyles, propStyles, cssStyles),
        localProps.class,
        localProps.className
      )
    }

    const classes = () => {
      if (localProps.unstyled) {
        const { css: cssStyles, ...propStyles } = styleProps
        return cx(css(propStyles, cssStyles), localProps.class, localProps.className)
      }
      return configOrCva.__recipe__ ? recipeClass() : cvaClass()
    }

    if (forwardedProps.className) {
      delete forwardedProps.className
    }

    return createComponent(
      Dynamic,
      mergeProps(forwardedProps, elementProps, normalizeHTMLProps(htmlProps), {
        get component() {
          return localProps.as
        },
        get class() {
          return classes()
        },
      })
    )
  }

  const name = getDisplayName(element)

  StyledComponent.displayName = `styled.${name}`
  StyledComponent.__cva__ = __cvaFn__
  StyledComponent.__base__ = element
  StyledComponent.__shouldForwardProps__ = shouldForwardProp

  return StyledComponent
}

function createJsxFactory() {
  const cache = new Map()

  return new Proxy(styledFn, {
    apply(_, __, args) {
      return styledFn(...args)
    },
    get(_, el) {
      if (!cache.has(el)) {
        cache.set(el, styledFn(el))
      }
      return cache.get(el)
    },
  })
}

export const styled = /* @__PURE__ */ createJsxFactory()
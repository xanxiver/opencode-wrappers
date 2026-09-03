import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getFlexStyle } from '../patterns/flex.mjs';
import { styled } from './factory.mjs';

export const Flex = /* @__PURE__ */ function Flex(props) {
  const [patternProps, restProps] = splitProps(props, ["align","justify","direction","wrap","basis","grow","shrink"])

const styleProps = getFlexStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
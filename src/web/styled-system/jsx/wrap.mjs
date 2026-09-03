import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getWrapStyle } from '../patterns/wrap.mjs';
import { styled } from './factory.mjs';

export const Wrap = /* @__PURE__ */ function Wrap(props) {
  const [patternProps, restProps] = splitProps(props, ["gap","rowGap","columnGap","align","justify"])

const styleProps = getWrapStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
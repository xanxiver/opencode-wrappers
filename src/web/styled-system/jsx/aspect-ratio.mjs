import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getAspectRatioStyle } from '../patterns/aspect-ratio.mjs';
import { styled } from './factory.mjs';

export const AspectRatio = /* @__PURE__ */ function AspectRatio(props) {
  const [patternProps, restProps] = splitProps(props, ["ratio"])

const styleProps = getAspectRatioStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
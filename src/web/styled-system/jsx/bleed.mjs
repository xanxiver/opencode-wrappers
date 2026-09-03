import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getBleedStyle } from '../patterns/bleed.mjs';
import { styled } from './factory.mjs';

export const Bleed = /* @__PURE__ */ function Bleed(props) {
  const [patternProps, restProps] = splitProps(props, ["inline","block"])

const styleProps = getBleedStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
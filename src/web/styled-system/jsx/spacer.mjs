import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getSpacerStyle } from '../patterns/spacer.mjs';
import { styled } from './factory.mjs';

export const Spacer = /* @__PURE__ */ function Spacer(props) {
  const [patternProps, restProps] = splitProps(props, ["size"])

const styleProps = getSpacerStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
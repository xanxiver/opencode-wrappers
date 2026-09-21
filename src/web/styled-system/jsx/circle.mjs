import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getCircleStyle } from '../patterns/circle.mjs';
import { styled } from './factory.mjs';

export const Circle = /* @__PURE__ */ function Circle(props) {
  const [patternProps, restProps] = splitProps(props, ["size"])

const styleProps = getCircleStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
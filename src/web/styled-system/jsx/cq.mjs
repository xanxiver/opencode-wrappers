import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getCqStyle } from '../patterns/cq.mjs';
import { styled } from './factory.mjs';

export const Cq = /* @__PURE__ */ function Cq(props) {
  const [patternProps, restProps] = splitProps(props, ["name","type"])

const styleProps = getCqStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
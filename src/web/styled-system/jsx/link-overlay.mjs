import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getLinkOverlayStyle } from '../patterns/link-overlay.mjs';
import { styled } from './factory.mjs';

export const LinkOverlay = /* @__PURE__ */ function LinkOverlay(props) {
  const [patternProps, restProps] = splitProps(props, [])

const styleProps = getLinkOverlayStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.a, mergedProps)
}
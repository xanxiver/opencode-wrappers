import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getGridStyle } from '../patterns/grid.mjs';
import { styled } from './factory.mjs';

export const Grid = /* @__PURE__ */ function Grid(props) {
  const [patternProps, restProps] = splitProps(props, ["gap","columnGap","rowGap","columns","minChildWidth"])

const styleProps = getGridStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
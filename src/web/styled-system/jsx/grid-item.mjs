import { createMemo, mergeProps, splitProps } from 'solid-js'
import { createComponent } from 'solid-js/web'

import { getGridItemStyle } from '../patterns/grid-item.mjs';
import { styled } from './factory.mjs';

export const GridItem = /* @__PURE__ */ function GridItem(props) {
  const [patternProps, restProps] = splitProps(props, ["colSpan","rowSpan","colStart","rowStart","colEnd","rowEnd"])

const styleProps = getGridItemStyle(patternProps)        
const mergedProps = mergeProps(styleProps, restProps)

return createComponent(styled.div, mergedProps)
}
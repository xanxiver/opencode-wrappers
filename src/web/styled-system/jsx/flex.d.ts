/* eslint-disable */
import type { Component } from 'solid-js'
import type { FlexProperties } from '../patterns/flex';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface FlexProps extends FlexProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof FlexProperties > {}


export declare const Flex: Component<FlexProps>
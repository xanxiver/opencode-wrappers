/* eslint-disable */
import type { Component } from 'solid-js'
import type { BoxProperties } from '../patterns/box';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface BoxProps extends BoxProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof BoxProperties > {}


export declare const Box: Component<BoxProps>
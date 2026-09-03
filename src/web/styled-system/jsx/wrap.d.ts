/* eslint-disable */
import type { Component } from 'solid-js'
import type { WrapProperties } from '../patterns/wrap';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface WrapProps extends WrapProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof WrapProperties > {}


export declare const Wrap: Component<WrapProps>
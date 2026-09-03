/* eslint-disable */
import type { Component } from 'solid-js'
import type { HstackProperties } from '../patterns/hstack';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface HstackProps extends HstackProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof HstackProperties > {}


export declare const HStack: Component<HstackProps>
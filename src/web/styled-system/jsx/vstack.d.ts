/* eslint-disable */
import type { Component } from 'solid-js'
import type { VstackProperties } from '../patterns/vstack';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface VstackProps extends VstackProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof VstackProperties > {}


export declare const VStack: Component<VstackProps>
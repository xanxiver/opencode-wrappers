/* eslint-disable */
import type { Component } from 'solid-js'
import type { AspectRatioProperties } from '../patterns/aspect-ratio';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface AspectRatioProps extends AspectRatioProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof AspectRatioProperties | 'aspectRatio'> {}


export declare const AspectRatio: Component<AspectRatioProps>
/* eslint-disable */
import type { Component } from 'solid-js'
import type { SquareProperties } from '../patterns/square';
import type { HTMLStyledProps } from '../types/jsx';
import type { DistributiveOmit } from '../types/system-types';

export interface SquareProps extends SquareProperties, DistributiveOmit<HTMLStyledProps<'div'>, keyof SquareProperties > {}


export declare const Square: Component<SquareProps>
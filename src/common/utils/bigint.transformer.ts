import { ValueTransformer } from 'typeorm';

/**
 * pg returns BIGINT as string. Amounts are stored as integer minor units, so values
 * stay well inside Number.MAX_SAFE_INTEGER (~9e15 minor units).
 */
export const bigintToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

import { Transform } from 'class-transformer';

export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const UpperTrim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value));

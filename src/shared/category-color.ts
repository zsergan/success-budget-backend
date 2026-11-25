import { AppColor } from './enums';

// Category.color: one of the presets, or a custom #RRGGBB kept upper-case
// (docs/type-contract.md#category-colors).
export type CategoryColor = AppColor | `#${string}`;

const PRESETS: ReadonlySet<string> = new Set(Object.values(AppColor));
const HEX = /^#[0-9a-fA-F]{6}$/;

export const CATEGORY_COLOR_PATTERN = `^(${Object.values(AppColor).join('|')}|#[0-9A-F]{6})$`;
export const CATEGORY_COLOR_RULE = `${Object.values(AppColor).join(', ')} or a #RRGGBB color`;

// the stored form of a valid color: a preset as it is, a custom one upper-case; null otherwise
export const normalizeCategoryColor = (value: unknown): CategoryColor | null => {
  if (typeof value !== 'string') {
    return null;
  }

  if (PRESETS.has(value)) {
    return value as AppColor;
  }

  return HEX.test(value) ? (value.toUpperCase() as CategoryColor) : null;
};

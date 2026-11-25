import { CATEGORY_COLOR_PATTERN, normalizeCategoryColor } from './category-color';
import { AppColor } from './enums';

describe('normalizeCategoryColor', () => {
  it.each(Object.values(AppColor))('keeps the preset %p exactly', (preset) => {
    expect(normalizeCategoryColor(preset)).toBe(preset);
  });

  it.each([
    ['#3A7BD5', '#3A7BD5'],
    ['#3a7bd5', '#3A7BD5'],
    ['#aBcDeF', '#ABCDEF'],
    ['#000000', '#000000'],
    ['#ffffff', '#FFFFFF'],
  ])('upper-cases the custom color %p', (value, stored) => {
    expect(normalizeCategoryColor(value)).toBe(stored);
  });

  it.each([
    '#FFF',
    '#3A7BD5FF',
    '3A7BD5',
    '#3A7BD',
    '#GGGGGG',
    ' #3A7BD5',
    '#3A7BD5 ',
    'red',
    'Slate',
    'SLATE',
    'rgb(58, 123, 213)',
    'hsl(210, 60%, 50%)',
    'var(--accent)',
    '',
    null,
    undefined,
    0x3a7bd5,
  ])('refuses %p', (value) => {
    expect(normalizeCategoryColor(value)).toBeNull();
  });

  it('describes exactly the stored forms in its OpenAPI pattern', () => {
    const pattern = new RegExp(CATEGORY_COLOR_PATTERN);

    expect(['slate', 'plum', '#3A7BD5'].every((value) => pattern.test(value))).toBe(true);
    expect(['#3a7bd5', 'Slate', '#FFF'].some((value) => pattern.test(value))).toBe(false);
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateCategoryDto } from './create-category.dto';
import { UpdateCategoryDto } from './update-category.dto';

const check = async <T extends object>(type: new () => T, plain: object) => {
  const dto = plainToInstance(type, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return {
    dto,
    errors: Object.fromEntries(errors.map((error) => [error.property, Object.values(error.constraints ?? {})])),
  };
};

const COLOR_ERROR = 'color must be one of slate, amber, evergreen, indigo, clay, plum or a #RRGGBB color';

describe('category color', () => {
  const create = { name: 'Coffee', transaction_type: 'expense', icon: 'Cafe' };

  it.each([
    ['clay', 'clay'],
    ['#3a7bd5', '#3A7BD5'],
    ['#3A7BD5', '#3A7BD5'],
  ])('takes %p on create and update, as %p', async (color, stored) => {
    const created = await check(CreateCategoryDto, { ...create, color });
    const updated = await check(UpdateCategoryDto, { color });

    expect(created.errors).toEqual({});
    expect(created.dto.color).toBe(stored);
    expect(updated.errors).toEqual({});
    expect(updated.dto.color).toBe(stored);
  });

  it.each(['#FFF', '#3A7BD5FF', '3A7BD5', 'red', 'Slate', 'rgb(1,2,3)', '', 42])('refuses %p', async (color) => {
    expect((await check(CreateCategoryDto, { ...create, color })).errors).toEqual({ color: [COLOR_ERROR] });
    expect((await check(UpdateCategoryDto, { color })).errors).toEqual({ color: [COLOR_ERROR] });
  });

  it('requires it on create, and refuses null on create and update', async () => {
    expect((await check(CreateCategoryDto, create)).errors).toEqual({ color: [COLOR_ERROR] });
    expect((await check(CreateCategoryDto, { ...create, color: null })).errors).toEqual({ color: [COLOR_ERROR] });
    expect((await check(UpdateCategoryDto, { color: null })).errors.color).toEqual(
      expect.arrayContaining(['color must not be null', COLOR_ERROR]),
    );
    expect((await check(UpdateCategoryDto, {})).errors).toEqual({});
  });
});

import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateBy } from 'class-validator';

import { CATEGORY_COLOR_RULE, normalizeCategoryColor } from '@shared/category-color';

// A preset token, or #RRGGBB in any case, upper-cased before it is stored.
export const IsCategoryColor = () =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) => normalizeCategoryColor(value) ?? value),
    ValidateBy({
      name: 'isCategoryColor',
      validator: {
        validate: (value: unknown) => normalizeCategoryColor(value) === value,
        defaultMessage: (args) => `${args?.property} must be one of ${CATEGORY_COLOR_RULE}`,
      },
    }),
  );

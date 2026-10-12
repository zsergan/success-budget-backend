import type { Type } from '@nestjs/common';
import { type ApiPropertyOptions, getSchemaPath } from '@nestjs/swagger';

// OpenAPI 3.0 has no null type; nullable next to a $ref is ignored by tools.
// The model must also be registered with @ApiExtraModels.
export const nullableObject = (model: Type<unknown>, description?: string): ApiPropertyOptions => ({
  anyOf: [{ $ref: getSchemaPath(model) }, { type: 'object', nullable: true, enum: [null] }],
  description,
});

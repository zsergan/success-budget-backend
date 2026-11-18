import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsEnum, IsObject, ValidateBy, ValidateNested, type ValidationArguments } from 'class-validator';

import { AssignmentKind } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';

const MAX_ID = 2147483647;

const isMember = (args: ValidationArguments) =>
  (args.object as TransactionAssignmentDto).kind === AssignmentKind.MEMBER;

// Swagger metadata is explicit: tests build the document without the CLI plugin.
export class TransactionAssignmentDto {
  @ApiProperty({
    enum: AssignmentKind,
    enumName: 'AssignmentKind',
    description: 'member: one member of the space; space: the whole space; unassigned: explicitly nobody.',
  })
  @IsEnum(AssignmentKind)
  kind!: AssignmentKind;

  @ApiPropertyOptional({
    type: 'integer',
    example: 31,
    description: 'Required with kind member: the user id of a current member. Absent otherwise.',
  })
  @ValidateBy({
    name: 'assignmentUserId',
    validator: {
      validate: (value: unknown, args) =>
        isMember(args!)
          ? typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID
          : value === undefined,
      defaultMessage: (args) =>
        isMember(args!)
          ? 'user_id must be the user id of a member, an integer from 1'
          : 'user_id must be absent unless kind is member',
    },
  })
  user_id?: number;
}

export const IsAssignment = ({ required }: { required: boolean }) =>
  applyDecorators(
    required ? IsDefined() : IsOptionalNonNull(),
    IsObject(),
    ValidateNested(),
    Type(() => TransactionAssignmentDto),
  );

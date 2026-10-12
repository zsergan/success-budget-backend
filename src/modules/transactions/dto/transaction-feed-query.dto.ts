import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min, ValidateBy } from 'class-validator';

import { TransactionKind, TransactionType } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsTimeZone } from '@shared/decorators/is-local-date.decorator';
import { FEED_CURSOR_MAX_LENGTH } from '../feed-cursor';

export const FEED_DEFAULT_LIMIT = 50;
export const FEED_MAX_LIMIT = 100;
export const FEED_MAX_QUERY_LENGTH = 255;

// Only plain digits become a number; anything else stays as sent and fails @IsInt.
const QueryInteger = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  );

const trimSearch = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  return trimmed === '' ? undefined : trimmed;
};

// Swagger metadata is explicit: tests build the document without the CLI plugin.
export class TransactionFeedQueryDto {
  @ApiProperty({
    description: 'First instant, inclusive, with Z or a UTC offset.',
    example: '2026-09-30T21:00:00.000Z',
  })
  @IsIsoInstant()
  @IsInTimestampRange()
  from!: string;

  @ApiProperty({
    description: 'Last instant, inclusive, with Z or a UTC offset; not before from.',
    example: '2026-10-31T20:59:59.999Z',
  })
  @IsIsoInstant()
  @IsInTimestampRange()
  to!: string;

  @ApiProperty({
    description: 'IANA zone of the device; groups day_totals. Fixed offsets are rejected.',
    example: 'Europe/Moscow',
  })
  @IsTimeZone()
  time_zone!: string;

  @ApiPropertyOptional({
    maxLength: FEED_MAX_QUERY_LENGTH,
    example: 'coffee',
    description:
      'Matches description, category or wallet name, ignoring case and accents. Trimmed; blank means no search; ' +
      `more than ${FEED_MAX_QUERY_LENGTH} characters after trimming is refused, not cut.`,
  })
  @Transform(trimSearch)
  @IsOptionalNonNull()
  @IsString()
  @ValidateBy({
    name: 'maxCodePoints',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || [...value].length <= FEED_MAX_QUERY_LENGTH,
      defaultMessage: () => `q must be at most ${FEED_MAX_QUERY_LENGTH} characters`,
    },
  })
  q?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: FEED_MAX_LIMIT, default: FEED_DEFAULT_LIMIT })
  @QueryInteger()
  @IsInt()
  @Min(1)
  @Max(FEED_MAX_LIMIT)
  limit: number = FEED_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: 'next_cursor or previous_cursor of a response to the same query; opaque. Not with around_id.',
  })
  @IsOptionalNonNull()
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEED_CURSOR_MAX_LENGTH)
  cursor?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Open the page that contains this transaction. Not with cursor.',
  })
  @IsOptionalNonNull()
  @IsString()
  around_id?: string;

  @ApiPropertyOptional({ enum: TransactionType, enumName: 'TransactionType' })
  @IsOptionalNonNull()
  @IsEnum(TransactionType)
  transaction_type?: TransactionType;

  @ApiPropertyOptional({
    enum: TransactionKind,
    enumName: 'TransactionKind',
    description: 'regular leaves out starting balances; initial_balance lists only them.',
  })
  @IsOptionalNonNull()
  @IsEnum(TransactionKind)
  kind?: TransactionKind;

  @ApiPropertyOptional({
    type: 'integer',
    description: 'A category of the space, archived allowed; the system one is refused.',
  })
  @QueryInteger()
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  category_id?: number;

  @ApiPropertyOptional({ type: 'integer', description: 'An active wallet of the space.' })
  @QueryInteger()
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  wallet_id?: number;
}

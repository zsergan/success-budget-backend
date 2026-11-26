import { ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';

import { CategoryIcon, TransactionType } from '@shared/enums';
import { CATEGORY_COLOR_PATTERN, type CategoryColor } from '@shared/category-color';

// Every property is decorated explicitly and the file has no .dto.ts suffix,
// so the CLI plugin adds nothing and the schema is the same in tests.

const INSTANT: ApiPropertyOptions = { type: String, format: 'date-time', example: '2026-09-28T12:00:00.000Z' };

// Not the Categories API item: only what a transaction row needs.
export class TransactionCategory {
  @ApiProperty({ type: 'integer', example: 12 })
  id!: number;

  @ApiProperty({ example: 'Grocery' })
  name!: string;

  @ApiProperty({ enum: TransactionType, enumName: 'TransactionType' })
  transaction_type!: TransactionType;

  @ApiProperty({ enum: CategoryIcon, enumName: 'CategoryIcon' })
  icon!: string;

  @ApiProperty({
    type: String,
    pattern: CATEGORY_COLOR_PATTERN,
    example: 'clay',
    description: 'A preset token or a custom #RRGGBB, upper-case, as stored.',
  })
  color!: CategoryColor;

  @ApiProperty({ type: 'integer', enum: [0, 1], description: 'Kept for compatibility; prefer is_archived.' })
  is_active!: number;

  @ApiProperty()
  is_archived!: boolean;

  @ApiProperty(INSTANT)
  created_at!: Date;

  @ApiProperty(INSTANT)
  updated_at!: Date;
}

export class TransactionCount {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'The feed summary.count for the same period, q and filters.',
  })
  count!: number;
}

export class TransactionFeedPageInfo {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Older records of the selection; null when there are none.',
  })
  next_cursor!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Newer records of the selection; null when there are none.',
  })
  previous_cursor!: string | null;
}

export class TransactionFeedSummary {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Records in the selection, initial balances included.' })
  count!: number;

  @ApiProperty({ pattern: '^\\d+\\.\\d{2}$', example: '2500.00', description: 'Initial balances excluded.' })
  income!: string;

  @ApiProperty({ pattern: '^\\d+\\.\\d{2}$', example: '1184.45' })
  expense!: string;
}

export class TransactionFeedDayTotal {
  @ApiProperty({ format: 'date', example: '2026-10-03', description: 'The stored date of records in items.' })
  date!: string;

  @ApiProperty({
    pattern: '^-?\\d+\\.\\d{2}$',
    example: '-31.50',
    description:
      'Income minus expense of the whole date in the selection, other pages included; initial balances excluded.',
  })
  net!: string;
}

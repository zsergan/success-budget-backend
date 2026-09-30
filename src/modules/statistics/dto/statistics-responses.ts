import type { Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, type ApiPropertyOptions, getSchemaPath } from '@nestjs/swagger';

import { AppColor, CategoryIcon, StatisticsPeriodType } from '@shared/enums';
import type {
  CategoryBreakdown as CategoryBreakdownShape,
  CategoryItem as CategoryItemShape,
  DeletedWalletsItem as DeletedWalletsItemShape,
  OtherItem as OtherItemShape,
  WalletBreakdown as WalletBreakdownShape,
  WalletItem as WalletItemShape,
} from '../statistics-breakdown';
import type {
  PreviousPeriod as PreviousPeriodShape,
  StatisticsPeriod as StatisticsPeriodShape,
} from '../statistics-period';
import type {
  Change as ChangeShape,
  MoneyCount as MoneyCountShape,
  StatisticsBreakdown as StatisticsBreakdownShape,
  StatisticsSummary as StatisticsSummaryShape,
  StatisticsTrend as StatisticsTrendShape,
  TrendBucket as TrendBucketShape,
} from '../statistics.service';

// Every property is decorated explicitly and the file has no .dto.ts suffix,
// so the CLI plugin adds nothing and the schema is the same in tests.

const TIME_STATES = ['past', 'current', 'future'];

const LOCAL_DATE: ApiPropertyOptions = { type: String, format: 'date', example: '2026-09-01' };
const INSTANT: ApiPropertyOptions = { type: String, format: 'date-time', example: '2026-08-31T21:00:00.000Z' };
const MONEY: ApiPropertyOptions = {
  type: String,
  pattern: '^-?\\d+\\.\\d{2}$',
  example: '810.50',
  description: 'Money as a decimal string with two digits after the point, never a number.',
};
const PERCENT: ApiPropertyOptions = { type: 'number', example: 12.5, description: 'Rounded to one decimal.' };
// OpenAPI 3.0 has no null type; nullable next to a $ref is ignored by tools.
const nullableObject = (model: Type<unknown>, description?: string): ApiPropertyOptions => ({
  anyOf: [{ $ref: getSchemaPath(model) }, { type: 'object', nullable: true, enum: [null] }],
  description,
});
const ALWAYS_NULL: ApiPropertyOptions = { type: String, nullable: true, enum: [null], description: 'Always null.' };

export class StatisticsPeriod implements StatisticsPeriodShape {
  @ApiProperty({ enum: StatisticsPeriodType, enumName: 'StatisticsPeriodType' })
  type!: StatisticsPeriodType;

  @ApiProperty({ example: 'Europe/Moscow', description: 'The applied IANA zone.' })
  time_zone!: string;

  @ApiProperty({ ...LOCAL_DATE, description: 'First local day, inclusive.' })
  start_date!: string;

  @ApiProperty({ ...LOCAL_DATE, example: '2026-09-30', description: 'Last local day, inclusive.' })
  end_date!: string;

  @ApiProperty({ ...INSTANT, description: 'First millisecond of start_date in time_zone.' })
  from!: Date;

  @ApiProperty({ ...INSTANT, example: '2026-09-30T20:59:59.999Z', description: 'Last millisecond of end_date.' })
  to!: Date;

  @ApiProperty({ ...INSTANT, example: '2026-09-28T12:00:00.000Z', description: 'The applied as_of.' })
  as_of!: Date;

  @ApiProperty({
    ...INSTANT,
    nullable: true,
    example: '2026-09-28T12:00:00.000Z',
    description: 'min(to, as_of): the end of the counted range; null while the period has not started.',
  })
  actual_to!: Date | null;

  @ApiProperty({ enum: TIME_STATES, enumName: 'StatisticsTimeState' })
  state!: 'past' | 'current' | 'future';
}

export class MoneyCount implements MoneyCountShape {
  @ApiProperty(MONEY)
  amount!: string;

  @ApiProperty({ type: 'integer', example: 9, description: 'Number of transactions.' })
  count!: number;
}

export class Change implements ChangeShape {
  @ApiProperty({ ...MONEY, example: '510.50', description: 'Current minus previous. ' + MONEY.description })
  delta!: string;

  @ApiProperty({ ...PERCENT, nullable: true, description: 'Of |previous|, one decimal; null when previous is zero.' })
  percent!: number | null;
}

export class Changes {
  @ApiProperty({ type: () => Change })
  income!: Change;

  @ApiProperty({ type: () => Change })
  expense!: Change;

  @ApiProperty({ type: () => Change })
  net!: Change;
}

export class PreviousPeriod implements PreviousPeriodShape {
  @ApiProperty({ ...LOCAL_DATE, description: 'The whole previous period, local dates.' })
  start_date!: string;

  @ApiProperty(LOCAL_DATE)
  end_date!: string;

  @ApiProperty(INSTANT)
  from!: Date;

  @ApiProperty(INSTANT)
  to!: Date;

  @ApiProperty({ ...INSTANT, description: 'The like-for-like cut of a current period, otherwise to.' })
  actual_to!: Date;

  @ApiProperty({ type: () => MoneyCount, description: 'Over from..actual_to.' })
  income!: MoneyCount;

  @ApiProperty({ type: () => MoneyCount })
  expense!: MoneyCount;

  @ApiProperty(MONEY)
  net!: string;

  @ApiProperty({ type: 'integer' })
  transactions_count!: number;
}

class StatisticsBlock {
  @ApiProperty({ type: () => StatisticsPeriod })
  period!: StatisticsPeriod;

  @ApiProperty({ example: 'EUR', description: 'Currency code of the space.' })
  currency!: string;
}

@ApiExtraModels(PreviousPeriod, Changes)
export class StatisticsSummary extends StatisticsBlock implements StatisticsSummaryShape {
  @ApiProperty({ type: () => MoneyCount })
  income!: MoneyCount;

  @ApiProperty({ type: () => MoneyCount })
  expense!: MoneyCount;

  @ApiProperty({ ...MONEY, description: 'income - expense. ' + MONEY.description })
  net!: string;

  @ApiProperty({ type: 'integer', description: 'income.count + expense.count.' })
  transactions_count!: number;

  @ApiProperty(nullableObject(PreviousPeriod, 'null for custom and future periods.'))
  previous!: PreviousPeriod | null;

  @ApiProperty(nullableObject(Changes, 'null exactly when previous is null.'))
  change!: Changes | null;

  @ApiProperty({ description: 'Any statistics transaction up to as_of, in any period.' })
  has_any_transactions!: boolean;

  @ApiProperty({
    ...LOCAL_DATE,
    nullable: true,
    description: 'Local date (in time_zone) of the latest one; null exactly when has_any_transactions is false.',
  })
  last_transaction_date!: string | null;
}

export class TrendBucket implements TrendBucketShape {
  @ApiProperty({ example: '2026-W40', description: 'Stable ISO key: 2026-09-28, 2026-W40 or 2026-09.' })
  key!: string;

  @ApiProperty({ ...LOCAL_DATE, description: 'Clipped to the period.' })
  start_date!: string;

  @ApiProperty(LOCAL_DATE)
  end_date!: string;

  @ApiProperty(INSTANT)
  from!: Date;

  @ApiProperty(INSTANT)
  to!: Date;

  @ApiProperty({ enum: TIME_STATES, enumName: 'StatisticsTimeState' })
  state!: 'past' | 'current' | 'future';

  @ApiProperty({ ...MONEY, nullable: true, description: 'null only for a future bucket. ' + MONEY.description })
  income!: string | null;

  @ApiProperty({ ...MONEY, nullable: true, description: 'null only for a future bucket. ' + MONEY.description })
  expense!: string | null;
}

export class TrendTotals {
  @ApiProperty({ type: () => MoneyCount })
  income!: MoneyCount;

  @ApiProperty({ type: () => MoneyCount })
  expense!: MoneyCount;
}

export class StatisticsTrend extends StatisticsBlock implements StatisticsTrendShape {
  @ApiProperty({ type: () => TrendTotals, description: 'Control sums, equal to the summary of the same cycle.' })
  totals!: TrendTotals;

  @ApiProperty({ enum: ['day', 'week', 'month'], enumName: 'StatisticsTrendGranularity' })
  granularity!: 'day' | 'week' | 'month';

  @ApiProperty({ type: () => TrendBucket, isArray: true, description: 'Chronological, covering the whole period.' })
  buckets!: TrendBucket[];
}

class BreakdownItemFields {
  @ApiProperty(MONEY)
  amount!: string;

  @ApiProperty({ ...PERCENT, description: 'Of the grouping total_amount, one decimal.' })
  percent!: number;
}

export class CategoryItem extends BreakdownItemFields implements CategoryItemShape {
  @ApiProperty({ enum: ['category'] })
  kind!: 'category';

  @ApiProperty({ example: 'category:12' })
  key!: string;

  @ApiProperty({ type: 'integer' })
  id!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: CategoryIcon, enumName: 'CategoryIcon' })
  icon!: string;

  @ApiProperty({ enum: AppColor, enumName: 'AppColor' })
  color!: AppColor;

  @ApiProperty()
  is_archived!: boolean;

  @ApiProperty({ enum: [true], description: 'Always true: opens the history filtered by category_id.' })
  opens_history!: boolean;
}

export class WalletItem extends BreakdownItemFields implements WalletItemShape {
  @ApiProperty({ enum: ['wallet'] })
  kind!: 'wallet';

  @ApiProperty({ example: 'wallet:3' })
  key!: string;

  @ApiProperty({ type: 'integer' })
  id!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty(ALWAYS_NULL)
  icon!: null;

  @ApiProperty({ enum: AppColor, enumName: 'AppColor', description: 'Wallet.design.' })
  color!: AppColor;

  @ApiProperty({ enum: [false] })
  is_archived!: boolean;

  @ApiProperty({ enum: [true], description: 'Always true: opens the history filtered by wallet_id.' })
  opens_history!: boolean;
}

// deleted_wallets and other: named and colored by the client, open nothing
class ServiceItemFields extends BreakdownItemFields {
  @ApiProperty(ALWAYS_NULL)
  id!: null;

  @ApiProperty(ALWAYS_NULL)
  name!: null;

  @ApiProperty(ALWAYS_NULL)
  icon!: null;

  @ApiProperty(ALWAYS_NULL)
  color!: null;

  @ApiProperty({ enum: [false] })
  is_archived!: boolean;

  @ApiProperty({ enum: [false] })
  opens_history!: boolean;
}

export class DeletedWalletsItem extends ServiceItemFields implements DeletedWalletsItemShape {
  @ApiProperty({ enum: ['deleted_wallets'] })
  kind!: 'deleted_wallets';

  @ApiProperty({ enum: ['deleted_wallets'] })
  key!: string;

  @ApiProperty({ type: 'integer', description: 'Deleted wallets with a positive sum.' })
  wallets_count!: number;
}

export class CategoryOtherItem extends ServiceItemFields implements OtherItemShape<CategoryItem> {
  @ApiProperty({ enum: ['other'] })
  kind!: 'other';

  @ApiProperty({ enum: ['other'] })
  key!: string;

  @ApiProperty({ type: () => CategoryItem, isArray: true, description: 'The folded categories, sorted.' })
  children!: CategoryItem[];
}

export class WalletOtherItem extends ServiceItemFields implements OtherItemShape<WalletItem> {
  @ApiProperty({ enum: ['other'] })
  kind!: 'other';

  @ApiProperty({ enum: ['other'] })
  key!: string;

  @ApiProperty({ type: () => WalletItem, isArray: true, description: 'The folded wallets, sorted.' })
  children!: WalletItem[];
}

@ApiExtraModels(CategoryOtherItem)
export class CategoryBreakdown implements CategoryBreakdownShape {
  @ApiProperty(MONEY)
  total_amount!: string;

  @ApiProperty({ type: 'integer', description: 'Categories with a positive sum.' })
  source_count!: number;

  @ApiProperty({ type: () => CategoryItem, isArray: true })
  primary_items!: CategoryItem[];

  @ApiProperty(nullableObject(CategoryOtherItem))
  other!: CategoryOtherItem | null;
}

@ApiExtraModels(DeletedWalletsItem, WalletOtherItem)
export class WalletBreakdown implements WalletBreakdownShape {
  @ApiProperty(MONEY)
  total_amount!: string;

  @ApiProperty({ type: 'integer', description: 'Wallets with a positive sum, deleted ones included.' })
  source_count!: number;

  @ApiProperty({ type: () => WalletItem, isArray: true, description: 'Active wallets only.' })
  primary_items!: WalletItem[];

  @ApiProperty(nullableObject(DeletedWalletsItem))
  deleted_wallets!: DeletedWalletsItem | null;

  @ApiProperty(nullableObject(WalletOtherItem))
  other!: WalletOtherItem | null;
}

export class StatisticsBreakdown extends StatisticsBlock implements StatisticsBreakdownShape {
  @ApiProperty({ type: () => MoneyCount, description: 'Control sum, equal to the summary expense of the same cycle.' })
  total!: MoneyCount;

  @ApiProperty({ type: () => CategoryBreakdown })
  by_category!: CategoryBreakdown;

  @ApiProperty({ type: () => WalletBreakdown })
  by_wallet!: WalletBreakdown;
}

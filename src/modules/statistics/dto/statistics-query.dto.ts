import { IsEnum } from 'class-validator';

import { StatisticsPeriodType } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsLocalDate, IsTimeZone } from '@shared/decorators/is-local-date.decorator';

export class StatisticsQueryDto {
  @IsEnum(StatisticsPeriodType)
  period!: StatisticsPeriodType;

  @IsOptionalNonNull()
  @IsLocalDate()
  anchor_date?: string;

  @IsOptionalNonNull()
  @IsLocalDate()
  from_date?: string;

  @IsOptionalNonNull()
  @IsLocalDate()
  to_date?: string;

  @IsTimeZone()
  time_zone!: string;

  @IsOptionalNonNull()
  @IsIsoInstant()
  @IsInTimestampRange()
  as_of?: string;
}

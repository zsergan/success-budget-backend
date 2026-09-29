import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { StatisticsPeriodType } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsLocalDate, IsTimeZone } from '@shared/decorators/is-local-date.decorator';

export class StatisticsQueryDto {
  @ApiProperty({ enum: StatisticsPeriodType })
  @IsEnum(StatisticsPeriodType)
  period!: StatisticsPeriodType;

  @ApiPropertyOptional({
    description: 'Any local day of the wanted week/month/year; not with custom. Default: the local day of as_of.',
    example: '2026-09-28',
  })
  @IsOptionalNonNull()
  @IsLocalDate()
  anchor_date?: string;

  @ApiPropertyOptional({ description: 'First local day, inclusive; custom only.', example: '2026-09-01' })
  @IsOptionalNonNull()
  @IsLocalDate()
  from_date?: string;

  @ApiPropertyOptional({ description: 'Last local day, inclusive; custom only.', example: '2026-09-30' })
  @IsOptionalNonNull()
  @IsLocalDate()
  to_date?: string;

  @ApiProperty({ description: 'IANA zone of the device; fixed offsets are rejected.', example: 'Europe/Moscow' })
  @IsTimeZone()
  time_zone!: string;

  @ApiPropertyOptional({
    description: 'Time boundary of the load cycle, with Z or an offset; the same for all three blocks. Default: now.',
    example: '2026-09-28T12:00:00.000Z',
  })
  @IsOptionalNonNull()
  @IsIsoInstant()
  @IsInTimestampRange()
  as_of?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { StatisticsPeriodType, TransactionType } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsCalendarDate, IsTimeZone } from '@shared/decorators/is-calendar-date.decorator';

export class StatisticsQueryDto {
  @ApiProperty({ enum: StatisticsPeriodType })
  @IsEnum(StatisticsPeriodType)
  period!: StatisticsPeriodType;

  @ApiPropertyOptional({
    description: 'Any day of the wanted week/month/year; not with custom. Default: today, the date of as_of.',
    example: '2026-09-28',
  })
  @IsOptionalNonNull()
  @IsCalendarDate()
  anchor_date?: string;

  @ApiPropertyOptional({ description: 'First day, inclusive; custom only.', example: '2026-09-01' })
  @IsOptionalNonNull()
  @IsCalendarDate()
  from_date?: string;

  @ApiPropertyOptional({ description: 'Last day, inclusive; custom only.', example: '2026-09-30' })
  @IsOptionalNonNull()
  @IsCalendarDate()
  to_date?: string;

  @ApiProperty({
    description: 'IANA zone of the device: tells which day as_of falls on. Fixed offsets are rejected.',
    example: 'Europe/Moscow',
  })
  @IsTimeZone()
  time_zone!: string;

  @ApiPropertyOptional({
    description:
      'Reference clock of the load cycle, with Z or an offset; its date in time_zone ends a current period. ' +
      'The same for all three blocks. Default: now.',
    example: '2026-09-28T12:00:00.000Z',
  })
  @IsOptionalNonNull()
  @IsIsoInstant()
  as_of?: string;
}

export class StatisticsBreakdownQueryDto extends StatisticsQueryDto {
  @ApiPropertyOptional({
    enum: TransactionType,
    enumName: 'TransactionType',
    description: 'Which transactions the breakdown groups; echoed as transaction_type. Default: expense.',
  })
  @IsOptionalNonNull()
  @IsEnum(TransactionType)
  transaction_type?: TransactionType;
}

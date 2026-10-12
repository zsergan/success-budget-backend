import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEnum, MaxLength } from 'class-validator';

import { AppColor } from '@shared/enums';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

export class CreateWalletDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  wallet_name!: string;

  @ApiProperty({
    example: '100.00',
    description:
      'Decimal string, 0 to 99999999.99, at most 2 decimals. Above 0 it is recorded as the initial balance transaction.',
  })
  @IsNotEmpty()
  @IsMoneyAmount()
  initial_balance!: string;

  @IsNotEmpty()
  @IsEnum(AppColor)
  design!: AppColor;
}

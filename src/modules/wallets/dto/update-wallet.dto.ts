import { IsString, IsEnum, MaxLength } from 'class-validator';
import { AppColor } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';

export class UpdateWalletDto {
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(20)
  wallet_name?: string;

  @IsOptionalNonNull()
  @IsEnum(AppColor)
  design?: AppColor;
}

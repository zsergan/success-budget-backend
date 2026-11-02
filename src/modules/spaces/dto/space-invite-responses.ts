import { ApiProperty } from '@nestjs/swagger';

class PreviewCurrency {
  id!: number;
  code!: string;
  name!: string;
}

class PreviewSpace {
  name!: string;
  currency!: PreviewCurrency;
}

export class SpaceInvitePreviewResponse {
  space!: PreviewSpace;

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at!: Date;
}

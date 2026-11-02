import { ApiProperty } from '@nestjs/swagger';

import { SpaceInviteEmailStatus, SpaceRole } from '@shared/enums';

const INSTANT = { type: String, format: 'date-time', example: '2026-11-08T10:00:00.000Z' } as const;
const EMAIL_STATUS_DESCRIPTION =
  'State of the latest invitation email; sent means the SMTP server accepted it, not that it reached the inbox.';
const RESEND_AFTER_DESCRIPTION = 'Seconds until resend is accepted; 0 when it is accepted now.';

export class SpaceInviteStateResponse {
  @ApiProperty({ type: 'integer', example: 87 })
  id!: number;

  @ApiProperty({ example: 'anna@example.com', description: 'Trimmed and lower-cased.' })
  email!: string;

  @ApiProperty({ ...INSTANT, description: 'Seven days after creation; a resend does not extend it.' })
  expires_at!: Date;

  @ApiProperty({
    enum: SpaceInviteEmailStatus,
    enumName: 'SpaceInviteEmailStatus',
    description: EMAIL_STATUS_DESCRIPTION,
  })
  email_status!: SpaceInviteEmailStatus;

  @ApiProperty({ type: 'integer', example: 60, description: RESEND_AFTER_DESCRIPTION })
  resend_after_seconds!: number;
}

export class CreatedSpaceInviteResponse extends SpaceInviteStateResponse {
  @ApiProperty({
    pattern: '^\\d{6}$',
    example: '042917',
    description: 'The manual six-digit code; this is the only response that contains it.',
  })
  code!: string;
}

export class SpaceMemberViewResponse {
  @ApiProperty({ enum: ['member', 'invite'] })
  type!: 'member' | 'invite';

  @ApiProperty({ type: 'integer', description: 'Membership id for a member row, invitation id for an invite row.' })
  id!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'The user behind a member row (DELETE :id/members/:userId takes it); null for an invite row.',
  })
  user_id!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'Always null for an invite row.' })
  name!: string | null;

  @ApiProperty({ example: 'anna@example.com' })
  email!: string;

  @ApiProperty({ enum: [...Object.values(SpaceRole), null], nullable: true, description: 'null for an invite row.' })
  role!: SpaceRole | null;

  @ApiProperty()
  can_remove!: boolean;

  @ApiProperty({
    enum: [...Object.values(SpaceInviteEmailStatus), null],
    nullable: true,
    description: `${EMAIL_STATUS_DESCRIPTION} null for a member row.`,
  })
  email_status!: SpaceInviteEmailStatus | null;

  @ApiProperty({ description: 'The caller is the owner, no attempt is running and the cooldown is over.' })
  can_resend!: boolean;

  @ApiProperty({ type: 'integer', nullable: true, description: `${RESEND_AFTER_DESCRIPTION} null for a member row.` })
  resend_after_seconds!: number | null;
}

class PreviewCurrency {
  @ApiProperty({ type: 'integer', example: 3 })
  id!: number;

  @ApiProperty({ example: 'EUR' })
  code!: string;

  @ApiProperty({ example: 'Euro' })
  name!: string;
}

class PreviewSpace {
  @ApiProperty({ example: 'Family' })
  name!: string;

  @ApiProperty({ type: PreviewCurrency })
  currency!: PreviewCurrency;
}

export class SpaceInvitePreviewResponse {
  @ApiProperty({ type: PreviewSpace })
  space!: PreviewSpace;

  @ApiProperty({ ...INSTANT })
  expires_at!: Date;
}

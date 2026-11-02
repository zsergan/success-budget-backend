import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PreviewSpaceInviteDto {
  /** The token from the invitation link (`/invite#token=...`). */
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  token!: string;
}

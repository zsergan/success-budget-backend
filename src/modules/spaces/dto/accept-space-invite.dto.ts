import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AcceptSpaceInviteDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(6)
  code: string;
}

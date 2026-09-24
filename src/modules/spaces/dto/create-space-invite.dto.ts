import { IsNotEmpty, IsEmail, MaxLength } from 'class-validator';

export class CreateSpaceInviteDto {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

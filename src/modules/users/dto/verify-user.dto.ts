import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyUserDto {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(6)
  code: string;
}

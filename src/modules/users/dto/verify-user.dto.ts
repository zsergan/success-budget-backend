import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class VerifyUserDto {
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsString()
  code: string;
}

import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginUserDto {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsNotEmpty()
  @IsString()
  password: string;
}

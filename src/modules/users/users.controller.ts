import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Request,
  UseInterceptors,
} from '@nestjs/common';

import { UsersService } from './users.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { VerifyUserDto } from './dto/verify-user.dto';
import type { AuthedRequest } from '../../shared/types';
import { ErrorMessages } from '../../shared/error-messages';
import { ConfirmationType } from '../../shared/enums';
import { generateRandomNumberString } from '../../shared/utils';
import { MAX_CONFIRMATION_CODE_ATTEMPTS } from '../../shared/constants';
import { Public } from '../../shared/decorators/public.decorator';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly confirmationCodesService: ConfirmationCodesService,
  ) {}

  @Public()
  @UseInterceptors(ClassSerializerInterceptor)
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    const userExists = await this.usersService.findByEmail(createUserDto.email);

    if (userExists && userExists.email_verified) {
      throw new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
    }

    const user = userExists
      ? await this.usersService.updateUnverified(userExists.id, createUserDto)
      : await this.usersService.register(createUserDto);

    const isConfirmationCodeCreated = await this.confirmationCodesService.getOne(user.id, ConfirmationType.EMAIL);

    if (!isConfirmationCodeCreated) {
      await this.confirmationCodesService.create({
        user_id: user.id,
        confirmation_code: generateRandomNumberString(),
        confirmation_type: ConfirmationType.EMAIL,
      });
    }

    return user;
  }

  @Public()
  @Post('verify-email')
  async verifyEmail(@Body() verifyUser: VerifyUserDto) {
    const user = await this.usersService.findByEmail(verifyUser.email);

    if (!user) {
      throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    const confirmationCode = await this.confirmationCodesService.getOne(user.id, ConfirmationType.EMAIL);

    if (!confirmationCode) {
      throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    if (confirmationCode.attempts >= MAX_CONFIRMATION_CODE_ATTEMPTS) {
      await this.confirmationCodesService.expire(user.id, ConfirmationType.EMAIL);
      throw new HttpException(ErrorMessages.TOO_MANY_ATTEMPTS, HttpStatus.TOO_MANY_REQUESTS);
    }

    if (confirmationCode.confirmation_code !== verifyUser.code) {
      await this.confirmationCodesService.incrementAttempts(confirmationCode.id);
      throw new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.BAD_REQUEST);
    }

    return this.usersService.completeEmailVerification(user, confirmationCode.id);
  }

  @Public()
  @Post('login')
  async login(@Body() loginUserDto: LoginUserDto) {
    return this.usersService.login(loginUserDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get('profile')
  async getProfile(@Request() req: AuthedRequest) {
    return this.usersService.findById(req.user.id);
  }
}

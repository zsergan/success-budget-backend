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
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { UsersService } from './users.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { VerifyUserDto } from './dto/verify-user.dto';
import type { AuthedRequest } from '../../shared/types';
import { ErrorMessages } from '../../shared/error-messages';
import { ConfirmationType } from '../../shared/enums';
import { MAX_CONFIRMATION_CODE_ATTEMPTS } from '../../shared/constants';
import { Public } from '../../shared/decorators/public.decorator';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly confirmationCodesService: ConfirmationCodesService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(ClassSerializerInterceptor)
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    const user = await this.usersService.registerOrRefresh(createUserDto);
    await this.confirmationCodesService.ensureCode(user.id, ConfirmationType.EMAIL);

    return user;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
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
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  async login(@Body() loginUserDto: LoginUserDto) {
    return this.usersService.login(loginUserDto);
  }

  @ApiBearerAuth()
  @UseInterceptors(ClassSerializerInterceptor)
  @Get('profile')
  async getProfile(@Request() req: AuthedRequest) {
    return this.usersService.findById(req.user.id);
  }
}

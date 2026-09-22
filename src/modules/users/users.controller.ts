import { Body, ClassSerializerInterceptor, Controller, Get, Post, Request, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { UsersService } from './users.service';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { MailService } from '@modules/mail/mail.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { VerifyUserDto } from './dto/verify-user.dto';
import type { AuthedRequest } from '@shared/types';
import { ConfirmationType } from '@shared/enums';
import { Public } from '@shared/decorators/public.decorator';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly confirmationCodesService: ConfirmationCodesService,
    private readonly mailService: MailService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(ClassSerializerInterceptor)
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    const user = await this.usersService.registerOrRefresh(createUserDto);
    const { code, shouldSend } = await this.confirmationCodesService.ensureCode(user.id, ConfirmationType.EMAIL);

    // Skipped within the resend cooldown (see ConfirmationCodesService) -
    // a repeat POST /register for the same still-unverified email (e.g. a
    // client retrying, or the user clicking "resend") reuses the same code
    // and doesn't hammer the mail provider. Delivery failure here throws a
    // controlled 503 (MailService) - the user/space/code rows already
    // committed are safe to retry against, not duplicated.
    if (shouldSend) {
      await this.mailService.sendConfirmationCode(user.email, code);
    }

    return user;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify-email')
  async verifyEmail(@Body() verifyUser: VerifyUserDto) {
    return this.usersService.verifyEmail(verifyUser);
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

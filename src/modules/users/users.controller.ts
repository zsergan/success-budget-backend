import {
  Body,
  Request,
  Controller,
  Get,
  Post,
  HttpException,
  HttpStatus,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';

import { UsersService } from './users.service';
import { HoldingsService } from '../holdings/holdings.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import type { AuthedRequest } from '../../shared/types';
import { ErrorMessages } from '../../shared/error-messages';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly holdingsService: HoldingsService,
  ) {}

  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    const userExists = await this.usersService.findByEmail(createUserDto.email);

    if (userExists) {
      throw new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
    }

    const { user, accessToken } = await this.usersService.register(createUserDto);
    await this.holdingsService.create(user.id, { name: 'Cash', balance: 0, currency_id: user.base_currency_id });

    return accessToken;
  }

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

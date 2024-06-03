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
import { WalletsService } from '../wallets/wallets.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { CategoriesService } from '../categories/categories.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { VerifyUserDto } from './dto/verify-user.dto';
import type { AuthedRequest } from '../../shared/types';
import { ErrorMessages } from '../../shared/error-messages';
import { ConfirmationType, TransactionType, WalletDesign } from '../../shared/enums';
import { generateRandomNumberString } from '../../shared/utils';

const defaultCategories = [
  { name: 'Salary', transaction_type: TransactionType.INCOME, icon: 'paid', color: '#222831' },
  { name: 'Gift', transaction_type: TransactionType.INCOME, icon: 'card-giftcard', color: '#222831' },
  { name: 'Housing', transaction_type: TransactionType.EXPENSE, icon: 'home', color: '#222831' },
  { name: 'Transportation', transaction_type: TransactionType.EXPENSE, icon: 'directions-bus', color: '#222831' },
  { name: 'Groceries', transaction_type: TransactionType.EXPENSE, icon: 'shopping-basket', color: '#222831' },
  { name: 'Restaurants', transaction_type: TransactionType.EXPENSE, icon: 'fastfood', color: '#222831' },
  { name: 'Car', transaction_type: TransactionType.EXPENSE, icon: 'directions-car', color: '#222831' },
  { name: 'Clothing', transaction_type: TransactionType.EXPENSE, icon: 'checkroom', color: '#222831' },
  { name: 'Health', transaction_type: TransactionType.EXPENSE, icon: 'healing', color: '#222831' },
  { name: 'Entertainment', transaction_type: TransactionType.EXPENSE, icon: 'sports-esports', color: '#222831' },
  { name: 'Education', transaction_type: TransactionType.EXPENSE, icon: 'school', color: '#222831' },
  { name: 'Rent', transaction_type: TransactionType.EXPENSE, icon: 'money', color: '#222831' },
  { name: 'Travel', transaction_type: TransactionType.EXPENSE, icon: 'flight', color: '#222831' },
  { name: 'Pets', transaction_type: TransactionType.EXPENSE, icon: 'pets', color: '#222831' },
  { name: 'Electronics', transaction_type: TransactionType.EXPENSE, icon: 'cable', color: '#222831' },
  { name: 'Utilities', transaction_type: TransactionType.EXPENSE, icon: 'water-drop', color: '#222831' },
];

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly walletsService: WalletsService,
    private readonly confirmationCodesService: ConfirmationCodesService,
    private readonly categoriesService: CategoriesService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    const userExists = await this.usersService.findByEmail(createUserDto.email);

    if (userExists && userExists.email_verified) {
      throw new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
    }

    const user = userExists ? userExists : await this.usersService.register(createUserDto);

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

    if (confirmationCode.confirmation_code !== verifyUser.code) {
      throw new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.BAD_REQUEST);
    }

    const accessToken = await this.usersService.verify(user.id);
    await this.confirmationCodesService.expire(user.id, ConfirmationType.EMAIL);

    await this.walletsService.create(user.id, {
      wallet_name: 'Cash',
      balance: 0,
      design: WalletDesign.GREEN,
      currency_id: user.base_currency_id,
    });

    await this.categoriesService.initiateCategories(user.id, defaultCategories);

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

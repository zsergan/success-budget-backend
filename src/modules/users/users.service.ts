import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';

import { User } from '../../entities/user.entity';
import { Wallet } from '../../entities/wallet.entity';
import { Category } from '../../entities/category.entity';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import type { CreateUserDto } from './dto/create-user.dto';
import type { LoginUserDto } from './dto/login-user.dto';
import { ErrorMessages } from '../../shared/error-messages';
import { WalletDesign } from '../../shared/enums';
import { DEFAULT_CATEGORIES } from '../../shared/constants';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-constant-time-login', 10);

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  private generateAccessToken(user: User): string {
    const jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
    return jwt.sign({ id: user.id }, jwtSecret, { expiresIn: 60 * 60 * 24 * 90 });
  }

  async register(createUserDto: CreateUserDto): Promise<User> {
    const user = this.userRepository.create(createUserDto);
    return await this.userRepository.save(user);
  }

  async registerOrRefresh(createUserDto: CreateUserDto): Promise<User> {
    const existing = await this.findByEmail(createUserDto.email);

    if (existing && existing.email_verified) {
      throw new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
    }

    return existing ? this.updateUnverified(existing.id, createUserDto) : this.register(createUserDto);
  }

  async updateUnverified(id: number, createUserDto: CreateUserDto): Promise<User> {
    const password = await bcrypt.hash(createUserDto.password, 10);

    await this.userRepository.update(id, {
      name: createUserDto.name,
      password,
      base_currency_id: createUserDto.base_currency_id,
    });

    return this.findById(id);
  }

  async verify(id: number): Promise<string> {
    await this.userRepository.update(id, { email_verified: 1 });
    const user = await this.findById(id);

    return this.generateAccessToken(user);
  }

  async completeEmailVerification(user: User, confirmationCodeId: number): Promise<string> {
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(User).update(user.id, { email_verified: 1 });
      await manager.getRepository(ConfirmationCode).update(confirmationCodeId, { expired_at: new Date() });

      const wallet = manager.getRepository(Wallet).create({
        user_id: user.id,
        wallet_name: 'Cash',
        balance: 0,
        design: WalletDesign.GREEN,
        currency_id: user.base_currency_id,
      });
      await manager.getRepository(Wallet).save(wallet);

      const categories = DEFAULT_CATEGORIES.map((category) => ({ ...category, user_id: user.id }));
      await manager.getRepository(Category).save(categories);
    });

    return this.generateAccessToken(user);
  }

  async login(loginUserDto: LoginUserDto): Promise<string> {
    const { email, password } = loginUserDto;
    const user = await this.userRepository.findOne({ where: { email } });

    const isPasswordValid = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);

    if (!user || !isPasswordValid) {
      throw new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
    }

    if (!user.email_verified) {
      throw new HttpException(ErrorMessages.EMAIL_NOT_VERIFIED, HttpStatus.FORBIDDEN);
    }

    return this.generateAccessToken(user);
  }

  async findById(id: number): Promise<User> {
    return this.userRepository
      .createQueryBuilder('user')
      .innerJoinAndSelect('user.baseCurrency', 'currency')
      .where({ id })
      .getOne();
  }

  async findByEmail(email: string): Promise<User> {
    return this.userRepository.findOne({ where: { email } });
  }
}

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import 'dotenv/config';

import { User } from '../../entities/user.entity';
import type { CreateUserDto } from './dto/create-user.dto';
import type { LoginUserDto } from './dto/login-user.dto';
import { ErrorMessages } from '../../shared/error-messages';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  private generateAccessToken(user: User): string {
    return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: 60 * 60 * 24 * 90 });
  }

  async register(createUserDto: CreateUserDto): Promise<User> {
    const user = this.userRepository.create(createUserDto);
    return await this.userRepository.save(user);
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

  async login(loginUserDto: LoginUserDto): Promise<string> {
    const { email, password } = loginUserDto;
    const user = await this.userRepository.findOne({ where: { email } });

    if (!user) {
      throw new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
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

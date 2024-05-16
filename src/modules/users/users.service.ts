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
    return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: 1000 * 60 * 60 * 24 * 90 });
  }

  async register(createUserDto: CreateUserDto): Promise<{ user: User; accessToken: string }> {
    const user = this.userRepository.create(createUserDto);
    await this.userRepository.save(user);

    const accessToken = this.generateAccessToken(user);

    return { user, accessToken };
  }

  async login(loginUserDto: LoginUserDto): Promise<{ accessToken: string }> {
    const { email, password } = loginUserDto;
    const user = await this.userRepository.findOne({ where: { email } });

    if (!user) {
      throw new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
    }

    const accessToken = this.generateAccessToken(user);

    return { accessToken };
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

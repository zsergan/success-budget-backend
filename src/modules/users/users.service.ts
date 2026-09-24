import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';

import { User } from '@entities/user.entity';
import { Wallet } from '@entities/wallet.entity';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import type { CreateUserDto } from './dto/create-user.dto';
import type { LoginUserDto } from './dto/login-user.dto';
import type { VerifyUserDto } from './dto/verify-user.dto';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { MailService } from '@modules/mail/mail.service';
import { createDefaultCategories, createSpaceWithOwner } from '@modules/spaces/space-setup';
import { ErrorMessages } from '@shared/error-messages';
import { ConfirmationType, AppColor, SpaceType } from '@shared/enums';
import { MAX_CONFIRMATION_CODE_ATTEMPTS } from '@shared/constants';
import { assertFound, constantTimeEquals } from '@shared/utils';
import type { EnvironmentVariables } from '@config/env.validation';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-constant-time-login', 10);

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService<EnvironmentVariables, true>,
    private readonly confirmationCodesService: ConfirmationCodesService,
    private readonly mailService: MailService,
  ) {}

  private generateAccessToken(user: User): string {
    const jwtSecret = this.configService.getOrThrow('JWT_SECRET', { infer: true });
    return jwt.sign({ id: user.id }, jwtSecret, { expiresIn: 60 * 60 * 24 * 90 });
  }

  async register(createUserDto: CreateUserDto): Promise<User> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).save(
        manager.getRepository(User).create({
          name: createUserDto.name,
          email: createUserDto.email,
          password: createUserDto.password,
        }),
      );

      await createSpaceWithOwner(
        manager,
        { name: 'Personal', type: SpaceType.PERSONAL, currency_id: createUserDto.base_currency_id },
        user.id,
      );

      return user;
    });
  }

  async registerAndSendConfirmation(createUserDto: CreateUserDto): Promise<User> {
    const user = await this.registerOrRefresh(createUserDto);

    // reserveSend() throws a 429 (RetryAfterException) instead of returning
    // when a prior attempt is still within its cooldown and unconfirmed -
    // the user/space/code rows already committed above are safe to retry
    // against on the next call, never duplicated.
    const reservation = await this.confirmationCodesService.reserveSend(user.id, ConfirmationType.EMAIL);

    if (reservation.shouldSend) {
      try {
        await this.mailService.sendConfirmationCode(user.email, reservation.code, reservation.expiresAt);
        await this.confirmationCodesService.markSent(reservation.id, reservation.attemptId);
      } catch (error) {
        await this.confirmationCodesService.markFailed(reservation.id, reservation.attemptId);
        throw error;
      }
    }

    return user;
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

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(User).update(id, { name: createUserDto.name, password });

      const spaceMember = await manager.getRepository(SpaceMember).findOneOrFail({ where: { user_id: id } });
      await manager.getRepository(Space).update(spaceMember.space_id, { currency_id: createUserDto.base_currency_id });
    });

    const user = await this.findById(id);
    assertFound(user);

    return user;
  }

  // Internal entry point (seed, tests): verifies the user without a code.
  async completeEmailVerification(userId: number): Promise<void> {
    await this.dataSource.transaction((manager) => this.initializeVerifiedUser(manager, userId));
  }

  async verifyEmail(verifyUserDto: VerifyUserDto): Promise<string> {
    const found = await this.findByEmail(verifyUserDto.email);

    if (!found) {
      throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // A rejected code is returned rather than thrown so the transaction
    // commits the attempt counter / expiry before the error reaches the client.
    const rejection = await this.dataSource.transaction(async (manager): Promise<HttpException | null> => {
      const user = await this.lockUser(manager, found.id);

      if (!user) {
        throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
      }

      if (user.email_verified) {
        throw new HttpException(ErrorMessages.EMAIL_ALREADY_VERIFIED, HttpStatus.CONFLICT);
      }

      const confirmationCode = await this.confirmationCodesService.lockActive(user.id, ConfirmationType.EMAIL, manager);

      if (!confirmationCode) {
        throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
      }

      if (confirmationCode.attempts >= MAX_CONFIRMATION_CODE_ATTEMPTS) {
        await this.confirmationCodesService.expire(confirmationCode.id, manager);
        return new HttpException(ErrorMessages.TOO_MANY_ATTEMPTS, HttpStatus.TOO_MANY_REQUESTS);
      }

      if (!constantTimeEquals(confirmationCode.confirmation_code, verifyUserDto.code)) {
        await this.confirmationCodesService.incrementAttempts(confirmationCode.id, manager);
        return new HttpException(ErrorMessages.INVALID_CREDENTIALS, HttpStatus.BAD_REQUEST);
      }

      await this.confirmationCodesService.expire(confirmationCode.id, manager);
      await this.initializeVerifiedUser(manager, user.id);

      return null;
    });

    if (rejection) {
      throw rejection;
    }

    return this.generateAccessToken(found);
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

  async getProfile(userId: number): Promise<User> {
    const user = await this.findById(userId);
    assertFound(user);

    return user;
  }

  async findById(id: number): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async exists(id: number): Promise<boolean> {
    const count = await this.userRepository.count({ where: { id } });
    return count > 0;
  }

  private async lockUser(manager: EntityManager, userId: number): Promise<User | null> {
    return manager
      .createQueryBuilder(User, 'user')
      .setLock('pessimistic_write')
      .where('user.id = :userId', { userId })
      .getOne();
  }

  // email_verified is set in the same transaction as the starter data, so
  // under the user lock it doubles as the "already initialized" marker.
  private async initializeVerifiedUser(manager: EntityManager, userId: number): Promise<void> {
    const user = await this.lockUser(manager, userId);
    assertFound(user);

    if (user.email_verified) {
      return;
    }

    await manager.getRepository(User).update(userId, { email_verified: 1 });

    // exactly one personal space is guaranteed here: it's created
    // transactionally in register(), and an unverified user has no JWT
    // (login() blocks unverified accounts), so there's no way to reach
    // POST /spaces and create another one before this point
    const spaceMember = await manager.getRepository(SpaceMember).findOneOrFail({ where: { user_id: userId } });
    const space = await manager.getRepository(Space).findOneOrFail({ where: { id: spaceMember.space_id } });

    await manager.getRepository(Wallet).save(
      manager.getRepository(Wallet).create({
        space_id: space.id,
        wallet_name: 'Cash',
        design: AppColor.SLATE,
      }),
    );

    await createDefaultCategories(manager, space.id);
  }
}

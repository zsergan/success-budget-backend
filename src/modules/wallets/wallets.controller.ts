import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { WalletsService, WalletsOverview } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import type { AuthedRequest } from '@shared/types';
import { getEndOfMonth, getStartOfMonth, assertBelongsToSpace } from '@shared/utils';
import { TransactionsService } from '@modules/transactions/transactions.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { ErrorMessages } from '@shared/error-messages';

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('spaces/:spaceId/wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly transactionsService: TransactionsService,
    private readonly spaceAccessService: SpaceAccessService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createWalletDto: CreateWalletDto,
  ) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    return this.walletsService.create(spaceId, createWalletDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':walletId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('walletId', ParseIntPipe) walletId: number,
    @Body() updateWalletDto: UpdateWalletDto,
  ) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const wallet = await this.walletsService.getOne(walletId);
    assertBelongsToSpace(wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    return this.walletsService.update(walletId, updateWalletDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('from') from: Date = getStartOfMonth(new Date()),
    @Query('to') to: Date = getEndOfMonth(new Date()),
  ): Promise<WalletsOverview> {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const wallets = await this.walletsService.getAll(spaceId);
    const walletIds = wallets.map((wallet) => wallet.id);
    const [periodTotals, balances] = await Promise.all([
      this.transactionsService.getPeriodTotals(walletIds, from, to),
      this.transactionsService.getBalances(walletIds),
    ]);

    return this.walletsService.buildOverview(spaceId, wallets, periodTotals, balances);
  }

  @Delete(':walletId')
  async delete(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('walletId', ParseIntPipe) walletId: number,
  ): Promise<boolean> {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const wallet = await this.walletsService.getOne(walletId);
    assertBelongsToSpace(wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    await this.walletsService.delete(walletId);

    return true;
  }
}

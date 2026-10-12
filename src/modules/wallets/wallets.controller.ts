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
import { getEndOfMonth, getStartOfMonth } from '@shared/utils';
import { ParseOptionalDatePipe } from '@shared/pipes/parse-optional-date.pipe';

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('spaces/:spaceId/wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createWalletDto: CreateWalletDto,
  ) {
    return this.walletsService.create(req.user.id, spaceId, createWalletDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':walletId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('walletId', ParseIntPipe) walletId: number,
    @Body() updateWalletDto: UpdateWalletDto,
  ) {
    return this.walletsService.update(req.user.id, spaceId, walletId, updateWalletDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('from', ParseOptionalDatePipe) from: Date = getStartOfMonth(new Date()),
    @Query('to', ParseOptionalDatePipe) to: Date = getEndOfMonth(new Date()),
  ): Promise<WalletsOverview> {
    return this.walletsService.getOverview(req.user.id, spaceId, from, to);
  }

  @Delete(':walletId')
  async delete(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('walletId', ParseIntPipe) walletId: number,
  ): Promise<boolean> {
    await this.walletsService.delete(req.user.id, spaceId, walletId);

    return true;
  }
}

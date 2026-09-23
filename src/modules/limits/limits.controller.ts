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
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthedRequest } from '@shared/types';
import { LimitsService } from './limits.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

@ApiTags('limits')
@ApiBearerAuth()
@Controller('spaces/:spaceId/limits')
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    return this.limitsService.getSummary(req.user.id, spaceId);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createLimitDto: CreateLimitDto,
  ) {
    return this.limitsService.create(req.user.id, spaceId, createLimitDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':limitId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('limitId', ParseIntPipe) limitId: number,
    @Body() updateLimitDto: UpdateLimitDto,
  ) {
    return this.limitsService.update(req.user.id, spaceId, limitId, updateLimitDto);
  }

  @Delete(':limitId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('limitId', ParseIntPipe) limitId: number,
  ): Promise<boolean> {
    await this.limitsService.remove(req.user.id, spaceId, limitId);

    return true;
  }
}

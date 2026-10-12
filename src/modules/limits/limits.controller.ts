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
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';

import type { AuthedRequest } from '@shared/types';
import { LimitsService } from './limits.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { ParseOptionalTimeZonePipe } from '@shared/pipes/parse-optional-time-zone.pipe';

@ApiTags('limits')
@ApiBearerAuth()
@Controller('spaces/:spaceId/limits')
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @ApiQuery({
    name: 'time_zone',
    required: false,
    description: "IANA zone of the device, e.g. Europe/Moscow; the month is counted in it. Default: the server's.",
  })
  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('time_zone', ParseOptionalTimeZonePipe) timeZone?: string,
  ) {
    return this.limitsService.getSummary(req.user.id, spaceId, timeZone);
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

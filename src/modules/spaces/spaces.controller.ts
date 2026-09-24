import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { SpacesService } from './spaces.service';
import { SpaceMembersService, SpaceMemberView } from './space-members.service';
import { SpaceInvitesService, CreatedSpaceInvite } from './space-invites.service';
import { CreateSpaceDto } from './dto/create-space.dto';
import { CreateSpaceInviteDto } from './dto/create-space-invite.dto';
import { AcceptSpaceInviteDto } from './dto/accept-space-invite.dto';
import type { AuthedRequest } from '@shared/types';

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spacesService: SpacesService,
    private readonly spaceMembersService: SpaceMembersService,
    private readonly spaceInvitesService: SpaceInvitesService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(@Request() req: AuthedRequest, @Body() createSpaceDto: CreateSpaceDto) {
    return this.spacesService.create(req.user.id, createSpaceDto);
  }

  @Get()
  async getAll(@Request() req: AuthedRequest) {
    return this.spacesService.getAllForUser(req.user.id);
  }

  @Post('invites/accept')
  async acceptInvite(@Request() req: AuthedRequest, @Body() acceptSpaceInviteDto: AcceptSpaceInviteDto) {
    return this.spaceInvitesService.accept(req.user.id, acceptSpaceInviteDto.code);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get(':id')
  async getOne(@Request() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.spacesService.getForMember(req.user.id, id);
  }

  @Get(':id/members')
  async getMembers(@Request() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<SpaceMemberView[]> {
    return this.spaceMembersService.getMembersWithInvites(req.user.id, id);
  }

  @Delete(':id')
  async remove(@Request() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<boolean> {
    await this.spacesService.remove(req.user.id, id);

    return true;
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post(':id/invites')
  async createInvite(
    @Request() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() createSpaceInviteDto: CreateSpaceInviteDto,
  ): Promise<CreatedSpaceInvite> {
    return this.spaceInvitesService.create(req.user.id, id, createSpaceInviteDto.email);
  }

  @Delete(':id/invites/:inviteId')
  async revokeInvite(
    @Request() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('inviteId', ParseIntPipe) inviteId: number,
  ): Promise<boolean> {
    await this.spaceInvitesService.revoke(req.user.id, id, inviteId);

    return true;
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Request() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<boolean> {
    await this.spaceMembersService.leaveOrRemove(id, req.user.id, userId);

    return true;
  }
}

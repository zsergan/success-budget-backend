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
import { SpaceMembersService } from './space-members.service';
import { SpaceInvitesService } from './space-invites.service';
import { CreateSpaceDto } from './dto/create-space.dto';
import { CreateSpaceInviteDto } from './dto/create-space-invite.dto';
import { AcceptSpaceInviteDto } from './dto/accept-space-invite.dto';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { UsersService } from '@modules/users/users.service';
import type { AuthedRequest } from '@shared/types';
import { SpaceRole } from '@shared/enums';

interface SpaceMemberView {
  type: 'member' | 'invite';
  id: number;
  // The user id behind this row -- distinct from `id`, which for a member
  // row is the *membership* id. DELETE :id/members/:userId expects this
  // value, not `id`. null for invite rows, which are removed by invite id
  // (`id`) via DELETE :id/invites/:inviteId instead.
  user_id: number | null;
  name: string | null;
  email: string;
  role: SpaceRole | null;
  can_remove: boolean;
}

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spacesService: SpacesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spaceMembersService: SpaceMembersService,
    private readonly spaceInvitesService: SpaceInvitesService,
    private readonly usersService: UsersService,
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
    const user = await this.usersService.findById(req.user.id);

    return this.spaceInvitesService.accept(req.user.id, user.email, acceptSpaceInviteDto.code);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get(':id')
  async getOne(@Request() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    await this.spaceAccessService.assertMembership(id, req.user.id);

    return this.spacesService.getOne(id);
  }

  @Get(':id/members')
  async getMembers(@Request() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<SpaceMemberView[]> {
    const caller = await this.spaceAccessService.assertMembership(id, req.user.id);
    const isOwner = caller.role === SpaceRole.OWNER;

    const [members, invites] = await Promise.all([
      this.spaceMembersService.getAll(id),
      this.spaceInvitesService.getActive(id),
    ]);

    const memberViews: SpaceMemberView[] = members.map((member) => ({
      type: 'member',
      id: member.id,
      user_id: member.user_id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      can_remove: isOwner && member.user_id !== req.user.id,
    }));

    const inviteViews: SpaceMemberView[] = invites.map((invite) => ({
      type: 'invite',
      id: invite.id,
      user_id: null,
      name: null,
      email: invite.email,
      role: null,
      can_remove: isOwner,
    }));

    return [...memberViews, ...inviteViews];
  }

  @Delete(':id')
  async remove(@Request() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<boolean> {
    await this.spaceAccessService.assertMembership(id, req.user.id, SpaceRole.OWNER);
    await this.spacesService.remove(id, req.user.id);

    return true;
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post(':id/invites')
  async createInvite(
    @Request() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() createSpaceInviteDto: CreateSpaceInviteDto,
  ) {
    await this.spaceAccessService.assertMembership(id, req.user.id, SpaceRole.OWNER);
    const space = await this.spacesService.getOne(id);
    const invite = await this.spaceInvitesService.create(space, createSpaceInviteDto.email);

    // the only response that ever exposes the raw code - every other view
    // (GET :id/members) only shows pending invites by email, never the code
    return { id: invite.id, email: invite.email, expires_at: invite.expires_at, code: invite.code };
  }

  @Delete(':id/invites/:inviteId')
  async revokeInvite(
    @Request() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('inviteId', ParseIntPipe) inviteId: number,
  ): Promise<boolean> {
    await this.spaceAccessService.assertMembership(id, req.user.id, SpaceRole.OWNER);
    await this.spaceInvitesService.revoke(inviteId, id);

    return true;
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Request() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<boolean> {
    await this.spaceAccessService.assertMembership(id, req.user.id);
    await this.spaceMembersService.leaveOrRemove(id, req.user.id, userId);

    return true;
  }
}

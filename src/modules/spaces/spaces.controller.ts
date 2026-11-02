import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SpacesService } from './spaces.service';
import { SpaceMembersService, SpaceMemberView } from './space-members.service';
import { SpaceInvitesService, CreatedSpaceInvite } from './space-invites.service';
import { CreateSpaceDto } from './dto/create-space.dto';
import { CreateSpaceInviteDto } from './dto/create-space-invite.dto';
import { AcceptSpaceInviteDto } from './dto/accept-space-invite.dto';
import { PreviewSpaceInviteDto } from './dto/preview-space-invite.dto';
import { SpaceInvitePreviewResponse } from './dto/space-invite-responses';
import type { AuthedRequest } from '@shared/types';
import { ParseIdempotencyKeyPipe } from '@shared/pipes/parse-idempotency-key.pipe';
import { RequestHeader } from '@shared/decorators/request-header.decorator';

const INVITE_LINK_THROTTLE = { default: { limit: 10, ttl: 60000 } };

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spacesService: SpacesService,
    private readonly spaceMembersService: SpaceMembersService,
    private readonly spaceInvitesService: SpaceInvitesService,
  ) {}

  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'A client-generated key, e.g. a UUID, per creation. A repeat with the same key and body within 24 hours ' +
      'returns the original space without creating another one or sending more invitation emails.',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED, SPACE_PERSONAL_NO_INVITES or SPACE_INVITE_LIMIT_REACHED.' })
  @ApiConflictResponse({ description: 'IDEMPOTENCY_KEY_REUSED: the key was used with a different body.' })
  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Body() createSpaceDto: CreateSpaceDto,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ) {
    return this.spacesService.create(req.user.id, createSpaceDto, { idempotencyKey });
  }

  @Get()
  async getAll(@Request() req: AuthedRequest) {
    return this.spacesService.getAllForUser(req.user.id);
  }

  @ApiOperation({ summary: 'Show the space of an invitation link before joining; changes nothing.' })
  @ApiOkResponse({ type: SpaceInvitePreviewResponse })
  @ApiNotFoundResponse({ description: 'SPACE_INVITE_UNUSABLE: unknown token, or the invitation has ended.' })
  @ApiForbiddenResponse({ description: 'SPACE_INVITE_EMAIL_MISMATCH: the invitation is for another account.' })
  @ApiConflictResponse({ description: 'SPACE_ALREADY_MEMBER, with spaceId: the caller is a member already.' })
  @Throttle(INVITE_LINK_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('invites/preview')
  async previewInvite(
    @Request() req: AuthedRequest,
    @Body() previewSpaceInviteDto: PreviewSpaceInviteDto,
  ): Promise<SpaceInvitePreviewResponse> {
    return this.spaceInvitesService.preview(req.user.id, previewSpaceInviteDto.token);
  }

  @ApiOperation({
    summary: 'Join a space with exactly one of code or token. A repeat by the account that joined returns the space.',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or SPACE_MEMBER_LIMIT_REACHED.' })
  @ApiNotFoundResponse({ description: 'NOT_FOUND (code) or SPACE_INVITE_UNUSABLE (token).' })
  @ApiForbiddenResponse({ description: 'SPACE_INVITE_EMAIL_MISMATCH (token only).' })
  @ApiConflictResponse({ description: 'SPACE_ALREADY_MEMBER, with spaceId.' })
  @Throttle(INVITE_LINK_THROTTLE)
  @Post('invites/accept')
  async acceptInvite(@Request() req: AuthedRequest, @Body() acceptSpaceInviteDto: AcceptSpaceInviteDto) {
    const { code, token } = acceptSpaceInviteDto;

    return token === undefined
      ? this.spaceInvitesService.accept(req.user.id, code as string)
      : this.spaceInvitesService.acceptToken(req.user.id, token);
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

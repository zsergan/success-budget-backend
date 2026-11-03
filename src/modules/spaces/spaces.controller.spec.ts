import { Test, TestingModule } from '@nestjs/testing';

import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SpaceMembersService } from './space-members.service';
import { SpaceInvitesService } from './space-invites.service';
import type { AuthedRequest } from '@shared/types';
import { withRelations } from '@shared/utils';
import { SpaceInviteEmailStatus, SpaceType } from '@shared/enums';
import { buildCurrency, buildSpace } from '@testing';

describe('SpacesController', () => {
  let controller: SpacesController;
  let spacesService: jest.Mocked<SpacesService>;
  let spaceMembersService: jest.Mocked<SpaceMembersService>;
  let spaceInvitesService: jest.Mocked<SpaceInvitesService>;

  const req: AuthedRequest = { user: { id: 1 } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SpacesController],
      providers: [
        {
          provide: SpacesService,
          useValue: { create: jest.fn(), getAllForUser: jest.fn(), getForMember: jest.fn(), remove: jest.fn() },
        },
        {
          provide: SpaceMembersService,
          useValue: { getMembersWithInvites: jest.fn(), leaveOrRemove: jest.fn() },
        },
        {
          provide: SpaceInvitesService,
          useValue: {
            create: jest.fn(),
            revoke: jest.fn(),
            resend: jest.fn(),
            accept: jest.fn(),
            acceptToken: jest.fn(),
            preview: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(SpacesController);
    spacesService = module.get(SpacesService);
    spaceMembersService = module.get(SpaceMembersService);
    spaceInvitesService = module.get(SpaceInvitesService);
  });

  it('getOne delegates to SpacesService.getForMember', async () => {
    const space = withRelations(buildSpace({ id: 10, currency: buildCurrency() }), 'currency');
    spacesService.getForMember.mockResolvedValue(space);

    await expect(controller.getOne(req, 10)).resolves.toBe(space);
    expect(spacesService.getForMember).toHaveBeenCalledWith(1, 10);
  });

  it('getMembers delegates to SpaceMembersService.getMembersWithInvites', async () => {
    spaceMembersService.getMembersWithInvites.mockResolvedValue([]);

    await expect(controller.getMembers(req, 10)).resolves.toEqual([]);
    expect(spaceMembersService.getMembersWithInvites).toHaveBeenCalledWith(1, 10);
  });

  it('remove delegates to SpacesService.remove and returns true', async () => {
    await expect(controller.remove(req, 10)).resolves.toBe(true);
    expect(spacesService.remove).toHaveBeenCalledWith(1, 10);
  });

  it('createInvite delegates to SpaceInvitesService.create', async () => {
    const created = {
      id: 3,
      email: 'a@example.com',
      expires_at: new Date(),
      code: '123456',
      email_status: SpaceInviteEmailStatus.QUEUED,
      resend_after_seconds: 60,
    };
    spaceInvitesService.create.mockResolvedValue(created);

    await expect(controller.createInvite(req, 10, { email: 'a@example.com' })).resolves.toBe(created);
    expect(spaceInvitesService.create).toHaveBeenCalledWith(1, 10, 'a@example.com');
  });

  it('resendInvite delegates to SpaceInvitesService.resend', async () => {
    const state = {
      id: 3,
      email: 'a@example.com',
      expires_at: new Date(),
      email_status: SpaceInviteEmailStatus.QUEUED,
      resend_after_seconds: 60,
    };
    spaceInvitesService.resend.mockResolvedValue(state);

    await expect(controller.resendInvite(req, 10, 3)).resolves.toBe(state);
    expect(spaceInvitesService.resend).toHaveBeenCalledWith(1, 10, 3);
  });

  it('revokeInvite delegates to SpaceInvitesService.revoke and returns true', async () => {
    await expect(controller.revokeInvite(req, 10, 5)).resolves.toBe(true);
    expect(spaceInvitesService.revoke).toHaveBeenCalledWith(1, 10, 5);
  });

  it('acceptInvite delegates to SpaceInvitesService.accept', async () => {
    const space = withRelations(buildSpace({ id: 10, currency: buildCurrency() }), 'currency');
    spaceInvitesService.accept.mockResolvedValue(space);

    await expect(controller.acceptInvite(req, { code: '123456' })).resolves.toBe(space);
    expect(spaceInvitesService.accept).toHaveBeenCalledWith(1, '123456');
  });

  it('acceptInvite with a token delegates to SpaceInvitesService.acceptToken', async () => {
    const space = withRelations(buildSpace({ id: 10, currency: buildCurrency() }), 'currency');
    spaceInvitesService.acceptToken.mockResolvedValue(space);

    await expect(controller.acceptInvite(req, { token: '5.abc' })).resolves.toBe(space);
    expect(spaceInvitesService.acceptToken).toHaveBeenCalledWith(1, '5.abc');
    expect(spaceInvitesService.accept).not.toHaveBeenCalled();
  });

  it('previewInvite delegates to SpaceInvitesService.preview', async () => {
    const preview = {
      space: { name: 'Family', currency: { id: 1, code: 'EUR', name: 'Euro' } },
      expires_at: new Date(),
    };
    spaceInvitesService.preview.mockResolvedValue(preview);

    await expect(controller.previewInvite(req, { token: '5.abc' })).resolves.toBe(preview);
    expect(spaceInvitesService.preview).toHaveBeenCalledWith(1, '5.abc');
  });

  it('create passes the Idempotency-Key to SpacesService.create', async () => {
    const dto = { name: 'Family', currency_id: 1, type: SpaceType.GROUP };
    await controller.create(req, dto, 'key-1');

    expect(spacesService.create).toHaveBeenCalledWith(1, dto, { idempotencyKey: 'key-1' });
  });

  it('removeMember delegates to SpaceMembersService.leaveOrRemove and returns true', async () => {
    await expect(controller.removeMember(req, 10, 2)).resolves.toBe(true);
    expect(spaceMembersService.leaveOrRemove).toHaveBeenCalledWith(10, 1, 2);
  });
});

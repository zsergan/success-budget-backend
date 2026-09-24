import { Test, TestingModule } from '@nestjs/testing';

import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SpaceMembersService } from './space-members.service';
import { SpaceInvitesService } from './space-invites.service';

describe('SpacesController', () => {
  let controller: SpacesController;
  let spacesService: jest.Mocked<SpacesService>;
  let spaceMembersService: jest.Mocked<SpaceMembersService>;
  let spaceInvitesService: jest.Mocked<SpaceInvitesService>;

  const req = { user: { id: 1 } } as any;

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
          useValue: { create: jest.fn(), revoke: jest.fn(), accept: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(SpacesController);
    spacesService = module.get(SpacesService);
    spaceMembersService = module.get(SpaceMembersService);
    spaceInvitesService = module.get(SpaceInvitesService);
  });

  it('getOne delegates to SpacesService.getForMember', async () => {
    spacesService.getForMember.mockResolvedValue({ id: 10 } as any);

    await expect(controller.getOne(req, 10)).resolves.toEqual({ id: 10 });
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
    const created = { id: 3, email: 'a@example.com', expires_at: new Date(), code: '123456' };
    spaceInvitesService.create.mockResolvedValue(created);

    await expect(controller.createInvite(req, 10, { email: 'a@example.com' })).resolves.toBe(created);
    expect(spaceInvitesService.create).toHaveBeenCalledWith(1, 10, 'a@example.com');
  });

  it('revokeInvite delegates to SpaceInvitesService.revoke and returns true', async () => {
    await expect(controller.revokeInvite(req, 10, 5)).resolves.toBe(true);
    expect(spaceInvitesService.revoke).toHaveBeenCalledWith(1, 10, 5);
  });

  it('acceptInvite delegates to SpaceInvitesService.accept', async () => {
    spaceInvitesService.accept.mockResolvedValue({ id: 10 } as any);

    await expect(controller.acceptInvite(req, { code: '123456' })).resolves.toEqual({ id: 10 });
    expect(spaceInvitesService.accept).toHaveBeenCalledWith(1, '123456');
  });

  it('removeMember delegates to SpaceMembersService.leaveOrRemove and returns true', async () => {
    await expect(controller.removeMember(req, 10, 2)).resolves.toBe(true);
    expect(spaceMembersService.leaveOrRemove).toHaveBeenCalledWith(10, 1, 2);
  });
});

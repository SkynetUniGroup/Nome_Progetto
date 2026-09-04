import { Test, TestingModule } from '@nestjs/testing';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('CredentialsController', () => {
  let controller: CredentialsController;
  let service: {
    create: jest.Mock;
    list: jest.Mock;
    remove: jest.Mock;
    revalidate: jest.Mock;
  };

  const credential = {
    id: 'cred-1',
    provider: 'GITHUB' as const,
    status: 'CONNECTED' as const,
    lastValidatedAt: '2026-08-20T10:30:00.000Z',
  };

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue(credential),
      list: jest.fn().mockResolvedValue([credential]),
      remove: jest.fn().mockResolvedValue(undefined),
      revalidate: jest.fn().mockResolvedValue(credential),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CredentialsController],
      providers: [{ provide: CredentialsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CredentialsController>(CredentialsController);
  });

  it('files a new credential under the caller, not under a body-supplied owner', async () => {
    const dto = { provider: 'GITHUB' as const, token: 'ghp_secret' };

    await expect(controller.create('user-1', dto)).resolves.toEqual(credential);
    expect(service.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('lists only the caller own credentials', async () => {
    await expect(controller.list('user-1')).resolves.toEqual([credential]);
    expect(service.list).toHaveBeenCalledWith('user-1');
  });

  it('scopes a deletion to the caller, so one user cannot delete another credential', async () => {
    await controller.remove('user-1', 'cred-1');

    expect(service.remove).toHaveBeenCalledWith('user-1', 'cred-1');
  });

  it('scopes a revalidation to the caller as well', async () => {
    await expect(controller.revalidate('user-1', 'cred-1')).resolves.toEqual(credential);
    expect(service.revalidate).toHaveBeenCalledWith('user-1', 'cred-1');
  });

  it('never echoes the submitted token back to the caller', async () => {
    const result = await controller.create('user-1', {
      provider: 'GITHUB' as const,
      token: 'ghp_secret',
    });

    expect(JSON.stringify(result)).not.toContain('ghp_secret');
  });
});

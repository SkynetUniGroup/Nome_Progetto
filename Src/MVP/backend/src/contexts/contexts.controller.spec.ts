import { Test, TestingModule } from '@nestjs/testing';
import { ContextsController } from './contexts.controller';
import { ContextsService } from './contexts.service';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('ContextsController', () => {
  let controller: ContextsController;
  let service: { create: jest.Mock };

  const context = {
    id: 'ctx-1',
    repoOwner: 'OWASP',
    repoName: 'NodeGoat',
    scopeType: 'FULL_REPOSITORY' as const,
  };

  beforeEach(async () => {
    service = { create: jest.fn().mockResolvedValue(context) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContextsController],
      providers: [{ provide: ContextsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ContextsController>(ContextsController);
  });

  it('creates the context on behalf of the authenticated caller', async () => {
    const dto = {
      repoUrl: 'https://github.com/OWASP/NodeGoat',
      branch: 'master',
      scopeType: 'FULL_REPOSITORY' as const,
    };

    await expect(controller.create('user-1', dto as never)).resolves.toEqual(context);
    expect(service.create).toHaveBeenCalledWith('user-1', dto);
  });
});

describe('RepositoriesController', () => {
  let controller: RepositoriesController;
  let service: { list: jest.Mock; refs: jest.Mock; tree: jest.Mock };

  beforeEach(async () => {
    service = {
      list: jest.fn().mockResolvedValue([{ owner: 'OWASP', name: 'NodeGoat' }]),
      refs: jest.fn().mockResolvedValue({ branches: ['master'], defaultBranch: 'master' }),
      tree: jest.fn().mockResolvedValue({ nodes: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RepositoriesController],
      providers: [{ provide: RepositoriesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<RepositoriesController>(RepositoriesController);
  });

  it('lists the repositories reachable with the caller own credential', async () => {
    await controller.list('user-1');

    expect(service.list).toHaveBeenCalledWith('user-1');
  });

  it('resolves the refs of the requested repository', async () => {
    await controller.refs('user-1', {
      repoUrl: 'https://github.com/OWASP/NodeGoat',
    } as never);

    expect(service.refs).toHaveBeenCalledWith('user-1', 'https://github.com/OWASP/NodeGoat');
  });

  it('reads the tree at the branch and commit the caller asked for', async () => {
    await controller.tree('user-1', {
      repoUrl: 'https://github.com/OWASP/NodeGoat',
      branch: 'master',
      commitSha: 'abc1234',
    } as never);

    expect(service.tree).toHaveBeenCalledWith(
      'user-1',
      'https://github.com/OWASP/NodeGoat',
      'master',
      'abc1234',
    );
  });

  it('passes an absent commit through as undefined rather than inventing one', async () => {
    await controller.tree('user-1', {
      repoUrl: 'https://github.com/OWASP/NodeGoat',
      branch: 'master',
    } as never);

    expect(service.tree).toHaveBeenCalledWith(
      'user-1',
      'https://github.com/OWASP/NodeGoat',
      'master',
      undefined,
    );
  });
});

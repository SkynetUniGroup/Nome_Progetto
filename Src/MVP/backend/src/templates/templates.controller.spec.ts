import { Test, TestingModule } from '@nestjs/testing';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('TemplatesController', () => {
  let controller: TemplatesController;
  let service: {
    save: jest.Mock;
    find: jest.Mock;
    remove: jest.Mock;
  };

  const attivo = {
    active: true,
    filename: 'template.md',
    content: '# Titolo',
    updatedAt: '2026-03-01T10:00:00.000Z',
  };

  beforeEach(async () => {
    service = {
      save: jest.fn().mockResolvedValue(attivo),
      find: jest.fn().mockResolvedValue(attivo),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [{ provide: TemplatesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(TemplatesController);
  });

  // L'identità arriva dal token verificato tramite @CurrentUser, non dal
  // corpo o dall'URL: qui si verifica solo che il controller la inoltri
  // intatta al servizio. Che il decoratore la prenda davvero dalla
  // richiesta è coperto in common/decorators/current-user.decorator.spec.ts.
  it('saves the template for the calling user', async () => {
    const dto = { filename: 'template.md', content: '# Titolo' };

    expect(await controller.save('user1', dto)).toEqual(attivo);
    expect(service.save).toHaveBeenCalledWith('user1', dto);
  });

  it('reads the template of the calling user', async () => {
    expect(await controller.find('user1')).toEqual(attivo);
    expect(service.find).toHaveBeenCalledWith('user1');
  });

  it('removes the template of the calling user', async () => {
    await controller.remove('user1');

    expect(service.remove).toHaveBeenCalledWith('user1');
  });

  it('asks for a different user template when a different user calls', async () => {
    await controller.find('user2');

    expect(service.find).toHaveBeenCalledWith('user2');
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { OperationsController } from './operations.controller';
import { AgentRegistry } from './agent-registry.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('OperationsController', () => {
  let controller: OperationsController;
  let registry: { getForRole: jest.Mock };

  beforeEach(async () => {
    registry = {
      getForRole: jest.fn().mockReturnValue([
        { operation: 'SECURITY_OWASP', label: 'Analisi Sicurezza OWASP' },
      ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [{ provide: AgentRegistry, useValue: registry }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<OperationsController>(OperationsController);
  });

  it('offers the operations allowed to the caller role', () => {
    // The role comes from the verified token, so a caller cannot widen its
    // own list by asking for a different one.
    const result = controller.findAll('SECURITY_AUDITOR');

    expect(registry.getForRole).toHaveBeenCalledWith('SECURITY_AUDITOR');
    expect(result).toEqual([
      { operation: 'SECURITY_OWASP', label: 'Analisi Sicurezza OWASP' },
    ]);
  });

  it('asks the registry again for a different role', () => {
    controller.findAll('DEVELOPER');

    expect(registry.getForRole).toHaveBeenCalledWith('DEVELOPER');
  });

  it('returns an empty list rather than failing when a role has no operations', () => {
    registry.getForRole.mockReturnValueOnce([]);

    expect(controller.findAll('PROJECT_MANAGER')).toEqual([]);
  });
});

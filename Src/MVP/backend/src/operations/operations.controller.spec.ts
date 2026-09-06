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

  // Qui si verifica l'inoltro del ruolo al registry e nient'altro: il
  // metodo viene chiamato passando il ruolo come argomento, quindi il
  // decoratore @CurrentUser('role') — che è ciò che davvero impedisce a un
  // chiamante di allargarsi la lista chiedendo un ruolo diverso — resta
  // fuori dal giro. Quella garanzia è coperta in
  // ../common/decorators/current-user.decorator.spec.ts.
  it('forwards the caller role to the registry and returns what it answers', () => {
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
});

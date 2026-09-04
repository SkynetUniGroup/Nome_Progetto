import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('AuthController', () => {
  let controller: AuthController;
  let service: {
    register: jest.Mock;
    login: jest.Mock;
    getProfile: jest.Mock;
  };

  const profile = {
    id: 'user-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@azienda.it',
    role: 'DEVELOPER' as const,
  };

  beforeEach(async () => {
    service = {
      register: jest.fn().mockResolvedValue(profile),
      login: jest.fn().mockResolvedValue({ accessToken: 'signed.jwt.token' }),
      getProfile: jest.fn().mockResolvedValue(profile),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: service }],
    })
      // The guard has its own spec; here we only care about the routing.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('answers the health probe without any authentication', () => {
    // Docker polls this before any user has ever logged in: if it required a
    // token the container would never be reported healthy.
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('hands a registration over to the service unchanged', async () => {
    const dto = {
      email: 'ada@azienda.it',
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: 'a-long-enough-password',
      role: 'DEVELOPER' as const,
    };

    await expect(controller.register(dto)).resolves.toEqual(profile);
    expect(service.register).toHaveBeenCalledWith(dto);
  });

  it('returns the token produced by a successful login', async () => {
    const dto = { email: 'ada@azienda.it', password: 'a-long-enough-password' };

    await expect(controller.login(dto)).resolves.toEqual({
      accessToken: 'signed.jwt.token',
    });
    expect(service.login).toHaveBeenCalledWith(dto);
  });

  it('resolves the current user from the token, not from the request body', async () => {
    // The caller cannot ask for somebody else's profile: the id comes from
    // the verified token.
    await expect(controller.getMe('user-1')).resolves.toEqual(profile);
    expect(service.getProfile).toHaveBeenCalledWith('user-1');
  });

  it('accepts a logout without touching any state', () => {
    // Stateless JWTs leave nothing to invalidate server-side; the endpoint
    // exists so an expired or forged token gets a real 401 from the guard.
    expect(controller.logout()).toBeUndefined();
  });
});

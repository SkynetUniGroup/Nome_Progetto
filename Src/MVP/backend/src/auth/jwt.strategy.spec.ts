import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  function build(secret: string | undefined = 'un-segreto-di-prova') {
    const config = { get: jest.fn().mockReturnValue(secret) } as unknown as ConfigService;
    return { strategy: new JwtStrategy(config), config };
  }

  it('reads the signing secret from the configuration, never from a literal', () => {
    const { config } = build();

    expect(config.get).toHaveBeenCalledWith('JWT_SECRET');
  });

  it('turns a verified payload into the identity the rest of the app uses', () => {
    // Passport has already checked signature and expiry by the time this
    // runs: this only reshapes the payload.
    const { strategy } = build();

    const user = strategy.validate({ sub: 'user-1', role: 'SECURITY_AUDITOR' });

    expect(user).toEqual({ userId: 'user-1', role: 'SECURITY_AUDITOR' });
  });

  it('carries the role through, so RolesGuard has something to check', () => {
    const { strategy } = build();

    expect(strategy.validate({ sub: 'u', role: 'DEVELOPER' }).role).toBe('DEVELOPER');
    expect(strategy.validate({ sub: 'u', role: 'PROJECT_MANAGER' }).role).toBe('PROJECT_MANAGER');
  });

  it('exposes nothing beyond the identity and the role', () => {
    // Anything else added here would silently become request.user across
    // every guarded route.
    const { strategy } = build();

    expect(Object.keys(strategy.validate({ sub: 'user-1', role: 'DEVELOPER' })).sort()).toEqual([
      'role',
      'userId',
    ]);
  });
});

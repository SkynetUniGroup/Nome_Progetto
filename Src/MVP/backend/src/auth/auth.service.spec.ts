import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { User } from './schemas/user.schema';

describe('AuthService', () => {
  let service: AuthService;
  let model: { create: jest.Mock; findOne: jest.Mock; findById: jest.Mock };
  let passwords: { hash: jest.Mock; verify: jest.Mock };
  let jwt: { sign: jest.Mock };

  const storedUser = {
    _id: { toString: () => 'user-1' },
    email: 'ada@azienda.it',
    firstName: 'Ada',
    lastName: 'Lovelace',
    passwordHash: '$argon2id$stored',
    role: 'DEVELOPER',
  };

  /** The duplicate-key error MongoDB raises on a unique index violation. */
  function duplicateKeyError() {
    return Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  }

  beforeEach(async () => {
    model = {
      create: jest.fn().mockResolvedValue(storedUser),
      findOne: jest.fn().mockResolvedValue(storedUser),
      findById: jest.fn().mockResolvedValue(storedUser),
    };
    passwords = {
      hash: jest.fn().mockResolvedValue('$argon2id$fresh'),
      verify: jest.fn().mockResolvedValue(true),
    };
    jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getModelToken(User.name), useValue: model },
        { provide: PasswordService, useValue: passwords },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    const dto = {
      email: 'ada@azienda.it',
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: 'a-long-enough-password',
      role: 'DEVELOPER' as const,
    };

    it('stores the hash and never the plaintext password', async () => {
      await service.register(dto);

      const persisted = model.create.mock.calls[0][0];
      expect(persisted.passwordHash).toBe('$argon2id$fresh');
      expect(JSON.stringify(persisted)).not.toContain(dto.password);
    });

    it('returns the profile without any credential material', async () => {
      const profile = await service.register(dto);

      expect(profile).toEqual({
        id: 'user-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@azienda.it',
        role: 'DEVELOPER',
      });
      expect(profile).not.toHaveProperty('passwordHash');
    });

    it('persists the role the caller asked for', async () => {
      await service.register({ ...dto, role: 'SECURITY_AUDITOR' as const });

      expect(model.create.mock.calls[0][0].role).toBe('SECURITY_AUDITOR');
    });

    it('rejects an email that is already registered', async () => {
      model.create.mockRejectedValueOnce(duplicateKeyError());

      await expect(service.register(dto)).rejects.toThrow(ConflictException);
    });

    it('does not disguise an unrelated database failure as a duplicate email', async () => {
      // Reporting "email already taken" for a connection failure would send
      // the user down a dead end: they would keep trying other addresses.
      model.create.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.register(dto)).rejects.toThrow('connection lost');
    });
  });

  describe('login', () => {
    const dto = { email: 'ada@azienda.it', password: 'a-long-enough-password' };

    it('issues a token carrying the user id and role', async () => {
      const result = await service.login(dto);

      expect(result).toEqual({ accessToken: 'signed.jwt.token' });
      expect(jwt.sign).toHaveBeenCalledWith({ sub: 'user-1', role: 'DEVELOPER' });
    });

    it('verifies the submitted password against the stored hash', async () => {
      await service.login(dto);

      expect(passwords.verify).toHaveBeenCalledWith('$argon2id$stored', dto.password);
    });

    it('rejects a wrong password', async () => {
      passwords.verify.mockResolvedValueOnce(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown email', async () => {
      model.findOne.mockResolvedValueOnce(null);
      passwords.verify.mockResolvedValueOnce(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('still runs a password verification for an unknown email', async () => {
      // Skipping the hash comparison when the account does not exist would
      // make that case measurably faster, letting an attacker tell registered
      // addresses from unregistered ones by timing alone.
      model.findOne.mockResolvedValueOnce(null);
      passwords.verify.mockResolvedValueOnce(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(passwords.verify).toHaveBeenCalledTimes(1);
      expect(passwords.verify.mock.calls[0][0]).toMatch(/^\$argon2id\$/);
    });

    it('gives the same message whether the email or the password is wrong', async () => {
      passwords.verify.mockResolvedValueOnce(false);
      const wrongPassword = await service.login(dto).catch((e) => e.message);

      model.findOne.mockResolvedValueOnce(null);
      passwords.verify.mockResolvedValueOnce(false);
      const unknownEmail = await service.login(dto).catch((e) => e.message);

      expect(unknownEmail).toBe(wrongPassword);
    });

    it('issues no token when the credentials are rejected', async () => {
      passwords.verify.mockResolvedValueOnce(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(jwt.sign).not.toHaveBeenCalled();
    });
  });

  describe('getProfile', () => {
    it('returns the profile of an existing user', async () => {
      const profile = await service.getProfile('user-1');

      expect(profile.email).toBe('ada@azienda.it');
      expect(model.findById).toHaveBeenCalledWith('user-1');
    });

    it('reports a valid token naming a deleted account as not found', async () => {
      model.findById.mockResolvedValueOnce(null);

      await expect(service.getProfile('user-gone')).rejects.toThrow(NotFoundException);
    });

    it('never exposes the password hash', async () => {
      const profile = await service.getProfile('user-1');

      expect(JSON.stringify(profile)).not.toContain('argon2id');
    });
  });
});

import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { CreateCredentialDto } from '../credentials/dto/create-credential.dto';
import { CreateContextDto } from '../contexts/dto/create-context.dto';

/**
 * Contract tests between this backend and the MVP frontend.
 *
 * Every payload below is copied verbatim from the frontend source that sends
 * it — the file and line are named on each case. They run through the same
 * ValidationPipe configured in main.ts (whitelist + forbidNonWhitelisted),
 * so an unknown property is a 400, not a silently dropped field. Nothing is
 * mocked: the DTOs and the pipe are the production ones.
 *
 * These caught a real break once — the frontend and backend had been built
 * against different shapes and never run together — so they stay as the
 * guard that keeps the two sides from drifting apart again.
 */
describe('Frontend/backend request contract', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  async function validate(dto: unknown, metatype: new () => object) {
    const metadata: ArgumentMetadata = { type: 'body', metatype, data: '' };
    return pipe.transform(dto, metadata);
  }

  /**
   * Returns the per-field complaints the pipe raised, or null if it accepted
   * the body. The field names live in the exception's response payload, not
   * in its message, which is always the bare "Bad Request Exception".
   */
  async function complaints(dto: unknown, metatype: new () => object) {
    try {
      await validate(dto, metatype);
      return null;
    } catch (error) {
      const response = (error as { getResponse: () => { message?: string[] } }).getResponse();
      return (response.message ?? []).join(' | ');
    }
  }

  describe('POST /credentials', () => {
    // frontend/src/pages/CredentialsPage.tsx — handle_submit
    const bodyTheFrontendSends = {
      provider: 'GITHUB',
      token: 'ghp_1234567890abcdef',
    };

    it('accepts the body the frontend actually sends', async () => {
      await expect(validate(bodyTheFrontendSends, CreateCredentialDto)).resolves.toEqual(
        bodyTheFrontendSends,
      );
    });

    it('rejects a provider outside the supported list', async () => {
      const reasons = await complaints(
        { provider: 'GITLAB', token: 'glpat_x' },
        CreateCredentialDto,
      );

      expect(reasons).toContain('provider');
    });

    it('rejects an empty token rather than storing a useless credential', async () => {
      const reasons = await complaints({ provider: 'GITHUB', token: '' }, CreateCredentialDto);

      expect(reasons).toContain('token');
    });

    it('rejects the shape the frontend used to send, so the old break cannot return', async () => {
      const reasons = await complaints(
        { githubPat: 'ghp_x', openaiApiKey: 'sk-x' },
        CreateCredentialDto,
      );

      expect(reasons).toContain('githubPat');
      expect(reasons).toContain('openaiApiKey');
    });
  });

  describe('POST /contexts', () => {
    // frontend/src/pages/SelectPage.tsx — handle_submit
    const bodyTheFrontendSends = {
      repoUrl: 'https://github.com/OWASP/NodeGoat',
      branch: 'master',
      scopeType: 'FULL_REPOSITORY',
    };

    it('accepts the body the frontend actually sends', async () => {
      await expect(validate(bodyTheFrontendSends, CreateContextDto)).resolves.toMatchObject(
        bodyTheFrontendSends,
      );
    });

    it('accepts a restricted scope with its paths', async () => {
      await expect(
        validate(
          {
            ...bodyTheFrontendSends,
            scopeType: 'FILES',
            paths: ['app/routes/session.js'],
          },
          CreateContextDto,
        ),
      ).resolves.toBeDefined();
    });

    it('accepts an optional commit pinned inside the branch', async () => {
      await expect(
        validate({ ...bodyTheFrontendSends, commitSha: 'abc1234' }, CreateContextDto),
      ).resolves.toBeDefined();
    });

    it('rejects a repository URL that is not a GitHub one', async () => {
      const reasons = await complaints(
        { ...bodyTheFrontendSends, repoUrl: 'https://gitlab.com/o/r' },
        CreateContextDto,
      );

      expect(reasons).toContain('repoUrl');
    });

    it('rejects an unknown scope type', async () => {
      const reasons = await complaints(
        { ...bodyTheFrontendSends, scopeType: 'TUTTO_IL_MONDO' },
        CreateContextDto,
      );

      expect(reasons).toContain('scopeType');
    });

    it('rejects the shape the frontend used to send, so the old break cannot return', async () => {
      const reasons = await complaints(
        { repoOwner: 'OWASP', repoName: 'NodeGoat', ref: 'master', scopeType: 'FULL_REPOSITORY' },
        CreateContextDto,
      );

      expect(reasons).toContain('repoUrl');
      expect(reasons).toContain('repoOwner');
    });
  });
});

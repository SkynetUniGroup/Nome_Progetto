import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { CreateCredentialDto } from '../credentials/dto/create-credential.dto';
import { CreateContextDto } from '../contexts/dto/create-context.dto';

/**
 * Contract tests between this backend and the MVP frontend.
 *
 * Every payload below is copied verbatim from the frontend source that sends
 * it — the file and line are named on each case. They run through the same
 * ValidationPipe configured in main.ts (whitelist + forbidNonWhitelisted),
 * so an unknown property is a 400, not a silently dropped field.
 *
 * The mismatches are marked `test.failing`: they pass while the defect is
 * present and start failing the moment someone aligns the two sides, which
 * is the signal to delete the marker. Nothing here is a mock of a mock —
 * the DTOs and the pipe are the production ones.
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
    // frontend/src/pages/CredentialsPage.tsx:98
    const bodyTheFrontendSends = {
      githubPat: 'ghp_xxxxxxxxxxxx',
      openaiApiKey: 'sk-xxxxxxxxxxxx',
    };

    test.failing('accepts the body the frontend actually sends', async () => {
      await expect(
        validate(bodyTheFrontendSends, CreateCredentialDto),
      ).resolves.toBeDefined();
    });

    it('accepts the body its own DTO describes', async () => {
      await expect(
        validate({ provider: 'GITHUB', token: 'ghp_xxxxxxxxxxxx' }, CreateCredentialDto),
      ).resolves.toEqual({ provider: 'GITHUB', token: 'ghp_xxxxxxxxxxxx' });
    });

    it('rejects the frontend body, naming the fields it does not know', async () => {
      // Pins the current behaviour so the diagnosis stays readable: the two
      // sides disagree on field names, not on validation strictness.
      const reasons = await complaints(bodyTheFrontendSends, CreateCredentialDto);

      expect(reasons).toContain('githubPat');
      expect(reasons).toContain('openaiApiKey');
    });
  });

  describe('POST /contexts', () => {
    // frontend/src/pages/SelectPage.tsx:92
    const bodyTheFrontendSends = {
      repoOwner: 'OWASP',
      repoName: 'NodeGoat',
      ref: 'master',
      scopeType: 'FULL_REPOSITORY',
    };

    test.failing('accepts the body the frontend actually sends', async () => {
      await expect(validate(bodyTheFrontendSends, CreateContextDto)).resolves.toBeDefined();
    });

    it('accepts the body its own DTO describes', async () => {
      await expect(
        validate(
          {
            repoUrl: 'https://github.com/OWASP/NodeGoat',
            branch: 'master',
            scopeType: 'FULL_REPOSITORY',
          },
          CreateContextDto,
        ),
      ).resolves.toBeDefined();
    });

    it('rejects the frontend body: it carries no repository URL at all', async () => {
      // The frontend splits the repository into owner and name; this DTO wants
      // the whole URL and matches it against a regex.
      const reasons = await complaints(bodyTheFrontendSends, CreateContextDto);

      expect(reasons).toContain('repoUrl');
      expect(reasons).toContain('repoOwner');
    });
  });
});

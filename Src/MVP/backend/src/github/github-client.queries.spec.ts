// Same mocking choice as github-client.service.spec.ts: Octokit is replaced
// so these stay fast, deterministic unit tests of our own mapping and
// caching logic rather than network calls.
const mockRequest = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: mockRequest,
    hook: { after: jest.fn(), before: jest.fn() },
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { createMockRedis, RedisTestModule } from '@nestjs-modules/ioredis';
import { GithubClientService } from './github-client.service';

const TOKEN = 'ghp_token_di_prova';

/** A repository as GitHub returns it, with only the fields we map. */
function githubRepo(over: Record<string, unknown> = {}) {
  return {
    owner: { login: 'OWASP' },
    name: 'NodeGoat',
    private: true,
    default_branch: 'master',
    language: 'JavaScript',
    ...over,
  };
}

/** An issue as GitHub returns it, with only the fields we map. */
function githubIssue(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Aggiunta esportazione PDF',
    state: 'closed',
    labels: [{ name: 'feat' }],
    milestone: { title: 'SPRINT-42' },
    closed_at: '2026-08-20T10:30:00Z',
    body: 'x'.repeat(80),
    ...over,
  };
}

describe('GithubClientService — queries and mapping', () => {
  let service: GithubClientService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRequest.mockReset();
    redis = createMockRedis();
    redis.get.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      imports: [RedisTestModule.forTest(undefined, redis)],
      providers: [GithubClientService],
    }).compile();

    service = module.get(GithubClientService);
  });

  describe('listRepositories', () => {
    it('maps GitHub repositories onto the shape the frontend consumes', async () => {
      mockRequest.mockResolvedValue({ data: [githubRepo()] });

      const repos = await service.listRepositories(TOKEN);

      expect(repos).toEqual([
        {
          owner: 'OWASP',
          name: 'NodeGoat',
          isPrivate: true,
          defaultBranch: 'master',
          primaryLanguage: 'JavaScript',
        },
      ]);
    });

    it('asks for the most recently updated repositories first', async () => {
      // The picker shows one page: sorting by activity puts what the user is
      // actually working on at the top of it.
      mockRequest.mockResolvedValue({ data: [] });

      await service.listRepositories(TOKEN);

      expect(mockRequest).toHaveBeenCalledWith('GET /user/repos', {
        sort: 'updated',
        per_page: 100,
      });
    });

    it('keeps a null primary language as null instead of inventing one', async () => {
      mockRequest.mockResolvedValue({ data: [githubRepo({ language: null })] });

      const [repo] = await service.listRepositories(TOKEN);

      expect(repo.primaryLanguage).toBeNull();
    });
  });

  describe('getRepository', () => {
    it('reads a single repository and maps it the same way as the list', async () => {
      mockRequest.mockResolvedValue({ data: githubRepo({ private: false }) });

      const repo = await service.getRepository(TOKEN, 'OWASP', 'NodeGoat');

      expect(mockRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}', {
        owner: 'OWASP',
        repo: 'NodeGoat',
      });
      expect(repo.isPrivate).toBe(false);
    });
  });

  describe('listRefs', () => {
    it('returns branches and tags together, each with its commit', async () => {
      mockRequest
        .mockResolvedValueOnce({ data: [{ name: 'master', commit: { sha: 'aaa' } }] })
        .mockResolvedValueOnce({ data: [{ name: 'v1.0.0', commit: { sha: 'bbb' } }] });

      const refs = await service.listRefs(TOKEN, 'OWASP', 'NodeGoat');

      expect(refs).toEqual({
        branches: [{ name: 'master', sha: 'aaa' }],
        tags: [{ name: 'v1.0.0', sha: 'bbb' }],
      });
    });

    it('fetches branches and tags in parallel, not one after the other', async () => {
      mockRequest.mockResolvedValue({ data: [] });

      await service.listRefs(TOKEN, 'OWASP', 'NodeGoat');

      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('returns empty lists for a repository with no tags', async () => {
      mockRequest
        .mockResolvedValueOnce({ data: [{ name: 'main', commit: { sha: 'aaa' } }] })
        .mockResolvedValueOnce({ data: [] });

      const refs = await service.listRefs(TOKEN, 'OWASP', 'NodeGoat');

      expect(refs.tags).toEqual([]);
    });
  });

  describe('resolveRefToSha', () => {
    it('turns a branch name into the commit it currently points at', async () => {
      // Everything downstream caches on the resolved SHA, so this is the
      // step that keeps a moving branch from poisoning a 24h cache entry.
      mockRequest.mockResolvedValue({ data: { sha: 'abc1234' } });

      const sha = await service.resolveRefToSha(TOKEN, 'OWASP', 'NodeGoat', 'master');

      expect(sha).toBe('abc1234');
      expect(mockRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/commits/{ref}', {
        owner: 'OWASP',
        repo: 'NodeGoat',
        ref: 'master',
      });
    });

    it('propagates the failure when the ref does not exist', async () => {
      mockRequest.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

      await expect(
        service.resolveRefToSha(TOKEN, 'OWASP', 'NodeGoat', 'branch-inesistente'),
      ).rejects.toThrow('Not Found');
    });
  });

  describe('getReadme', () => {
    it('decodes the README GitHub itself recognizes for the repository', async () => {
      mockRequest.mockResolvedValue({
        data: {
          path: 'README.rst',
          content: Buffer.from('# Progetto\n').toString('base64'),
          sha: 'file-sha',
        },
      });

      const readme = await service.getReadme(TOKEN, 'OWASP', 'NodeGoat', 'abc1234');

      expect(readme?.path).toBe('README.rst');
      expect(readme?.content).toBe('# Progetto\n');
    });

    it('reports absence as null: a repository without a README is not an error', async () => {
      mockRequest.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

      await expect(service.getReadme(TOKEN, 'OWASP', 'NodeGoat', 'abc1234')).resolves.toBeNull();
    });

    it('caches the absence too, so a missing README is not re-fetched', async () => {
      mockRequest.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

      await service.getReadme(TOKEN, 'OWASP', 'NodeGoat', 'abc1234');

      expect(redis.set).toHaveBeenCalledWith(
        'github:readme:OWASP/NodeGoat@abc1234',
        'null',
        'EX',
        expect.any(Number),
      );
    });

    it('serves a cache hit without calling GitHub', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ path: 'README.md', content: '# X' }));

      const readme = await service.getReadme(TOKEN, 'OWASP', 'NodeGoat', 'abc1234');

      expect(readme?.path).toBe('README.md');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('does not swallow a failure that is not a missing file', async () => {
      // Caching a null here would hide an expired token or a rate limit
      // behind "this repository has no README" for the next 24 hours.
      mockRequest.mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));

      await expect(service.getReadme(TOKEN, 'OWASP', 'NodeGoat', 'abc1234')).rejects.toThrow(
        'Bad credentials',
      );
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('listIssues', () => {
    it('leaves out pull requests, which the same endpoint also returns', async () => {
      mockRequest.mockResolvedValue({
        data: [githubIssue({ number: 1 }), githubIssue({ number: 2, pull_request: { url: 'x' } })],
      });

      const issues = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
    });

    it('defaults to every state, so the caller decides what to filter', async () => {
      mockRequest.mockResolvedValue({ data: [] });

      await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(mockRequest.mock.calls[0][1]).toMatchObject({ state: 'all' });
    });

    it('forwards the requested state', async () => {
      mockRequest.mockResolvedValue({ data: [] });

      await service.listIssues(TOKEN, 'OWASP', 'NodeGoat', 'closed');

      expect(mockRequest.mock.calls[0][1]).toMatchObject({ state: 'closed' });
    });

    it('normalises labels, which GitHub returns as strings or as objects', async () => {
      mockRequest.mockResolvedValue({
        data: [githubIssue({ labels: ['bug', { name: 'feat' }, {}] })],
      });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.labels).toEqual(['bug', 'feat', '']);
    });

    it('carries the milestone through as the sprint identifier', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue()] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.milestone).toBe('SPRINT-42');
    });

    it('keeps a missing milestone as null', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue({ milestone: null })] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.milestone).toBeNull();
    });

    it('parses the closing date into a real Date', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue()] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.closedAt).toBeInstanceOf(Date);
      expect(issue.closedAt?.toISOString()).toBe('2026-08-20T10:30:00.000Z');
    });

    it('keeps an open issue closing date as null', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue({ state: 'open', closed_at: null })] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.closedAt).toBeNull();
    });
  });

  describe('quality gate on issue metadata', () => {
    // This flag is what the Changelog agent reads to decide whether an issue
    // carries enough substance to produce a changelog entry, or whether the
    // user has to be asked about it.

    it('accepts an issue with a substantial description', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue({ body: 'x'.repeat(51) })] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.hasSufficientMetadata).toBe(true);
    });

    it('rejects a description too short to describe anything', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue({ body: 'fix' })] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.hasSufficientMetadata).toBe(false);
    });

    it('rejects an issue with no description at all', async () => {
      mockRequest.mockResolvedValue({ data: [githubIssue({ body: null })] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.hasSufficientMetadata).toBe(false);
    });

    it('rejects a description sitting exactly on the boundary', async () => {
      // The threshold is "more than 50", not "at least 50".
      mockRequest.mockResolvedValue({ data: [githubIssue({ body: 'x'.repeat(50) })] });

      const [issue] = await service.listIssues(TOKEN, 'OWASP', 'NodeGoat');

      expect(issue.hasSufficientMetadata).toBe(false);
    });
  });

  describe('getIssueDetail', () => {
    it('returns the summary fields plus the full body', async () => {
      mockRequest.mockResolvedValue({ data: githubIssue({ body: 'Descrizione completa.' }) });

      const issue = await service.getIssueDetail(TOKEN, 'OWASP', 'NodeGoat', 42);

      expect(issue.number).toBe(42);
      expect(issue.body).toBe('Descrizione completa.');
    });

    it('substitutes an empty body rather than null', async () => {
      mockRequest.mockResolvedValue({ data: githubIssue({ body: null }) });

      const issue = await service.getIssueDetail(TOKEN, 'OWASP', 'NodeGoat', 42);

      expect(issue.body).toBe('');
    });

    it('asks for the issue number the caller named', async () => {
      mockRequest.mockResolvedValue({ data: githubIssue() });

      await service.getIssueDetail(TOKEN, 'OWASP', 'NodeGoat', 7);

      expect(mockRequest.mock.calls[0][1]).toMatchObject({ issue_number: 7 });
    });
  });
});

import { ReportAssemblyService } from './report-assembly.service';
import { AgentRunPayload } from '../tasks/agent-client.types';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'task-oid',
    id: 'task1',
    userId: 'user1',
    operation: 'DOCS_README',
    contextId: 'ctx1',
    accumulatedMs: 4200,
    ...overrides,
  };
}

// A real unified diff, newlines and all: it is not Markdown, and the
// assertions below exist to prove the sanitizing never touches it.
const DIFF = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n');

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    repoOwner: 'SkynetUniGroup',
    repoName: 'Code_Guardian',
    repoUrl: 'https://github.com/SkynetUniGroup/Code_Guardian',
    branch: 'main',
    resolvedSha: 'abc123',
    scopeType: 'FULL_REPOSITORY',
    paths: [],
    ...overrides,
  };
}

describe('ReportAssemblyService', () => {
  let service: ReportAssemblyService;
  let reportModel: { create: jest.Mock; deleteOne: jest.Mock };
  let contextModel: { findById: jest.Mock };
  let agentRegistry: { getDisplayName: jest.Mock };

  beforeEach(() => {
    reportModel = {
      create: jest.fn().mockResolvedValue({ id: 'report1' }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    contextModel = { findById: jest.fn() };
    agentRegistry = {
      getDisplayName: jest.fn().mockReturnValue('README generation/update'),
    };
    service = new ReportAssemblyService(
      reportModel as never,
      contextModel as never,
      agentRegistry as never,
    );
  });

  describe('assembleCompleted', () => {
    it('denormalizes the context, composes a deterministic title, and persists the sanitized body', async () => {
      contextModel.findById.mockResolvedValue(makeContext());
      const payload: AgentRunPayload = {
        body: [{ kind: 'TEXT', markdown: '<b>hi</b>' }],
        summary: 'all good',
        tokensConsumed: 100,
      };

      await service.assembleCompleted(makeTask() as never, payload);

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-oid',
          userId: 'user1',
          operation: 'DOCS_README',
          status: 'COMPLETED',
          title: 'README generation/update — SkynetUniGroup/Code_Guardian@main',
          summary: 'all good',
          durationMs: 4200,
          tokensConsumed: 100,
          context: {
            repoOwner: 'SkynetUniGroup',
            repoName: 'Code_Guardian',
            repoUrl: 'https://github.com/SkynetUniGroup/Code_Guardian',
            branch: 'main',
            resolvedSha: 'abc123',
            scopeType: 'FULL_REPOSITORY',
            paths: [],
          },
          body: [{ kind: 'TEXT', markdown: 'hi' }],
        }),
      );
    });

    it('defaults summary to null when the agent did not provide one', async () => {
      contextModel.findById.mockResolvedValue(makeContext());

      await service.assembleCompleted(makeTask() as never, { body: [] });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ summary: null }),
      );
    });

    it('carries the proposal through unsanitized (a diff, not Markdown)', async () => {
      contextModel.findById.mockResolvedValue(makeContext());
      const proposal = {
        targetPath: 'README.md',
        diffUnified: '--- a\n+++ b\n',
        language: 'markdown',
        pullRequestUrl: null,
      };

      await service.assembleCompleted(makeTask() as never, {
        body: [],
        proposal,
      });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ proposal }),
      );
    });

    it('throws when the AnalysisContext no longer exists', async () => {
      contextModel.findById.mockResolvedValue(null);

      await expect(
        service.assembleCompleted(makeTask() as never, { body: [] }),
      ).rejects.toThrow('AnalysisContext');
      expect(reportModel.create).not.toHaveBeenCalled();
    });
  });

  describe('what the agent writes, at the boundary', () => {
    // BE-18 puts the sanitizing at the boundary so that screen and PDF
    // consume the same string. `body` went through it from the start; these
    // two crossed the same boundary from the same agent and did not.
    it('sanitizes the summary', async () => {
      contextModel.findById.mockResolvedValue(makeContext());

      await service.assembleCompleted(makeTask() as never, {
        body: [],
        summary: 'vedi [qui](javascript:alert(1)) e <script>alert(2)</script>',
      });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'vedi qui e alert(2)' }),
      );
    });

    it('leaves a null summary null rather than sanitizing the string "null"', async () => {
      contextModel.findById.mockResolvedValue(makeContext());

      await service.assembleCompleted(makeTask() as never, { body: [] });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ summary: null }),
      );
    });

    it('drops a pullRequestUrl the allowlist rejects, keeping the rest of the proposal', async () => {
      // The one field of Proposal a frontend renders as a link. diffUnified
      // is not Markdown and must survive byte for byte.
      contextModel.findById.mockResolvedValue(makeContext());

      await service.assembleCompleted(makeTask() as never, {
        body: [],
        proposal: {
          targetPath: 'README.md',
          diffUnified: DIFF,
          language: 'markdown',
          pullRequestUrl: 'javascript:alert(1)',
        },
      });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal: {
            targetPath: 'README.md',
            diffUnified: DIFF,
            language: 'markdown',
            pullRequestUrl: null,
          },
        }),
      );
    });

    it('keeps an https pullRequestUrl untouched', async () => {
      contextModel.findById.mockResolvedValue(makeContext());

      await service.assembleCompleted(makeTask() as never, {
        body: [],
        proposal: {
          targetPath: 'README.md',
          diffUnified: '',
          language: 'markdown',
          pullRequestUrl: 'https://github.com/o/r/pull/1',
        },
      });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal: {
            targetPath: 'README.md',
            diffUnified: '',
            language: 'markdown',
            pullRequestUrl: 'https://github.com/o/r/pull/1',
          },
        }),
      );
    });

    it('leaves an absent proposal absent', async () => {
      contextModel.findById.mockResolvedValue(makeContext());

      await service.assembleCompleted(makeTask() as never, { body: [] });

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ proposal: undefined }),
      );
    });
  });

  describe('assembleFailed', () => {
    it('persists an empty body, null summary/durationMs, and the mapped error — title still present', async () => {
      contextModel.findById.mockResolvedValue(makeContext());
      const error = {
        code: 'UPSTREAM' as const,
        message: 'boom',
        stage: 'EXECUTION',
      };

      await service.assembleFailed(makeTask() as never, error);

      expect(reportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          title: 'README generation/update — SkynetUniGroup/Code_Guardian@main',
          summary: null,
          durationMs: null,
          body: [],
          error: { kind: 'UPSTREAM', message: 'boom', stage: 'EXECUTION' },
        }),
      );
    });
  });
  describe('discard', () => {
    it('deletes exactly the Report it is given, by _id', async () => {
      // Never a query by taskId: a Task legitimately re-run ("Riprova"
      // creates a new Task, but a paused/resumed one does not) can have more
      // than one Report against it, and only the row this invocation created
      // is orphaned.
      await service.discard({ _id: 'report-oid' } as never);

      expect(reportModel.deleteOne).toHaveBeenCalledWith({
        _id: 'report-oid',
      });
      expect(reportModel.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('lets a delete failure surface to the caller', async () => {
      // The swallow belongs to TaskProcessor, which knows the job must not
      // fail over it; this method stays honest about what happened so a
      // different caller could decide differently.
      reportModel.deleteOne.mockRejectedValue(new Error('mongo down'));

      await expect(
        service.discard({ _id: 'report-oid' } as never),
      ).rejects.toThrow('mongo down');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { Report } from './schemas/report.schema';
import { Task } from '../tasks/schemas/task.schema';

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report1',
    taskId: { toString: () => 'task1' },
    operation: 'DOCS_README',
    status: 'COMPLETED',
    title: 'README generation/update — owner/repo@main',
    summary: 'all good',
    durationMs: 4200,
    tokensConsumed: 100,
    generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    context: { repoOwner: 'owner', repoName: 'repo' },
    body: [{ kind: 'TEXT', markdown: 'hi' }],
    proposal: undefined,
    error: undefined,
    ...overrides,
  };
}

describe('ReportsService', () => {
  let service: ReportsService;
  let reportModel: { find: jest.Mock; findOne: jest.Mock };
  let taskModel: { findById: jest.Mock };

  beforeEach(async () => {
    reportModel = { find: jest.fn(), findOne: jest.fn() };
    taskModel = { findById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getModelToken(Report.name), useValue: reportModel },
        { provide: getModelToken(Task.name), useValue: taskModel },
      ],
    }).compile();

    service = module.get(ReportsService);
  });

  describe('findAllForUser', () => {
    it('scopes the query to the caller and returns thin summaries, newest first', async () => {
      const sort = jest.fn().mockResolvedValue([makeReport()]);
      reportModel.find.mockReturnValue({ sort });

      const result = await service.findAllForUser('user1', {});

      expect(reportModel.find).toHaveBeenCalledWith({ userId: 'user1' });
      expect(sort).toHaveBeenCalledWith({ generatedAt: -1 });
      expect(result).toEqual([
        {
          id: 'report1',
          operation: 'DOCS_README',
          status: 'COMPLETED',
          title: 'README generation/update — owner/repo@main',
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      // Thin on purpose — body/proposal/error/summary/durationMs never leak
      // into the list.
      expect(result[0]).not.toHaveProperty('body');
      expect(result[0]).not.toHaveProperty('summary');
    });

    it('adds an operation filter when provided', async () => {
      const sort = jest.fn().mockResolvedValue([]);
      reportModel.find.mockReturnValue({ sort });

      await service.findAllForUser('user1', { operation: 'SECURITY_OWASP' });

      expect(reportModel.find).toHaveBeenCalledWith({
        userId: 'user1',
        operation: 'SECURITY_OWASP',
      });
    });

    it('adds a generatedAt range filter from from/to', async () => {
      const sort = jest.fn().mockResolvedValue([]);
      reportModel.find.mockReturnValue({ sort });

      await service.findAllForUser('user1', {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      });

      expect(reportModel.find).toHaveBeenCalledWith({
        userId: 'user1',
        generatedAt: {
          $gte: new Date('2026-01-01T00:00:00.000Z'),
          $lte: new Date('2026-02-01T00:00:00.000Z'),
        },
      });
    });
  });

  describe('findOneForUser', () => {
    it('throws NotFoundException when no report matches (id, userId) together', async () => {
      reportModel.findOne.mockResolvedValue(null);

      await expect(service.findOneForUser('user1', 'report1')).rejects.toThrow(
        NotFoundException,
      );
      expect(reportModel.findOne).toHaveBeenCalledWith({
        _id: 'report1',
        userId: 'user1',
      });
    });

    it('throws the same NotFoundException for a report owned by someone else — 404, never 403', async () => {
      reportModel.findOne.mockResolvedValue(null);

      await expect(
        service.findOneForUser('attacker', 'someone-elses-report'),
      ).rejects.toThrow(NotFoundException);

      // Senza questa asserzione il test era un doppione del precedente: il
      // mock risolve a null a prescindere dagli argomenti, quindi "il
      // report è di un altro" non veniva mai messo in scena. È qui che si
      // vede che l'identità di chi chiede entra nella query — e che non
      // esiste un ramo che carichi il report e poi risponda 403.
      expect(reportModel.findOne).toHaveBeenCalledWith({
        _id: 'someone-elses-report',
        userId: 'attacker',
      });
    });

    it('returns the full ReportDto with pendingAction taken from the owning Task', async () => {
      const report = makeReport();
      reportModel.findOne.mockResolvedValue(report);
      taskModel.findById.mockResolvedValue({
        pendingInput: {
          kind: 'BUSINESS_CONFIRMATION',
          technicalReportId: 'r0',
        },
      });

      const result = await service.findOneForUser('user1', 'report1');

      expect(taskModel.findById).toHaveBeenCalledWith(report.taskId);
      expect(result.pendingAction).toEqual({
        kind: 'BUSINESS_CONFIRMATION',
        technicalReportId: 'r0',
      });
      expect(result.taskId).toBe('task1');
      expect(result.body).toEqual([{ kind: 'TEXT', markdown: 'hi' }]);
    });

    it('degrades pendingAction to null rather than failing when the owning Task is missing', async () => {
      reportModel.findOne.mockResolvedValue(makeReport());
      taskModel.findById.mockResolvedValue(null);

      const result = await service.findOneForUser('user1', 'report1');

      expect(result.pendingAction).toBeNull();
    });
  });
});

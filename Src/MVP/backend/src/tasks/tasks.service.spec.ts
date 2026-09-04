import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { getQueueToken } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { Task } from './schemas/task.schema';
import { AnalysisContext } from '../contexts/schemas/analysis-context.schema';
import { CredentialsService } from '../credentials/credentials.service';
import { AgentRegistry } from '../operations/agent-registry.service';
import { EventsGateway } from '../events/events.gateway';
import { UsageLimitService } from './usage-limit.service';

describe('TasksService', () => {
  let service: TasksService;
  let taskModel: {
    findOne: jest.Mock;
    find: jest.Mock;
    insertMany: jest.Mock;
    updateOne: jest.Mock;
  };
  let contextModel: { findOne: jest.Mock };
  let credentials: { hasCredential: jest.Mock };
  let agentRegistry: { getForRole: jest.Mock };
  let events: { emitTaskUpdated: jest.Mock };
  let queue: { addBulk: jest.Mock; add: jest.Mock };
  let usageLimit: { checkAndIncrement: jest.Mock };

  const developer = { userId: 'user1', role: 'DEVELOPER' as const };

  beforeEach(async () => {
    taskModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      insertMany: jest.fn(),
      // Conditional writes match by default; the tests about losing a race
      // against TaskProcessor override this.
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    contextModel = { findOne: jest.fn() };
    credentials = { hasCredential: jest.fn() };
    agentRegistry = { getForRole: jest.fn() };
    events = { emitTaskUpdated: jest.fn() };
    queue = { addBulk: jest.fn(), add: jest.fn() };
    // Passes by default — only the dedicated usage-limit tests below need
    // it to reject, everything else is testing the other three checks.
    usageLimit = { checkAndIncrement: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: getModelToken(Task.name), useValue: taskModel },
        {
          provide: getModelToken(AnalysisContext.name),
          useValue: contextModel,
        },
        { provide: CredentialsService, useValue: credentials },
        { provide: AgentRegistry, useValue: agentRegistry },
        { provide: EventsGateway, useValue: events },
        { provide: UsageLimitService, useValue: usageLimit },
        { provide: getQueueToken('tasks'), useValue: queue },
      ],
    }).compile();

    service = module.get(TasksService);
  });

  describe('createBatch', () => {
    it('rejects an empty operations array with 400, before touching the database', async () => {
      await expect(
        service.createBatch(developer, { contextId: 'ctx1', operations: [] }),
      ).rejects.toThrow(BadRequestException);
      expect(contextModel.findOne).not.toHaveBeenCalled();
    });

    it('rejects when the context does not exist or is not owned by the caller', async () => {
      contextModel.findOne.mockResolvedValue(null);

      await expect(
        service.createBatch(developer, {
          contextId: 'ctx1',
          operations: ['DOCS_README'],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(contextModel.findOne).toHaveBeenCalledWith({
        _id: 'ctx1',
        userId: 'user1',
      });
    });

    it('rejects when no GitHub credential is configured', async () => {
      contextModel.findOne.mockResolvedValue({ _id: 'ctx1' });
      credentials.hasCredential.mockResolvedValue(false);

      await expect(
        service.createBatch(developer, {
          contextId: 'ctx1',
          operations: ['DOCS_README'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects the whole batch with 403 if any operation is not permitted for the role', async () => {
      contextModel.findOne.mockResolvedValue({ _id: 'ctx1' });
      credentials.hasCredential.mockResolvedValue(true);
      agentRegistry.getForRole.mockReturnValue([
        {
          code: 'DOCS_README',
          displayName: '',
          description: '',
          agent: 'DOCS',
        },
      ]);

      await expect(
        service.createBatch(developer, {
          contextId: 'ctx1',
          operations: ['DOCS_README', 'SECURITY_OWASP'],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(taskModel.insertMany).not.toHaveBeenCalled();
    });

    it('deduplicates operations, persists one Task per operation under a shared batchId, and enqueues one job each', async () => {
      contextModel.findOne.mockResolvedValue({ _id: 'ctx1' });
      credentials.hasCredential.mockResolvedValue(true);
      agentRegistry.getForRole.mockReturnValue([
        {
          code: 'DOCS_README',
          displayName: '',
          description: '',
          agent: 'DOCS',
        },
        {
          code: 'DOCS_INLINE',
          displayName: '',
          description: '',
          agent: 'DOCS',
        },
      ]);
      taskModel.insertMany.mockResolvedValue([
        { id: 'task1', batchId: 'batchA' },
        { id: 'task2', batchId: 'batchA' },
      ]);

      const result = await service.createBatch(developer, {
        contextId: 'ctx1',
        operations: ['DOCS_README', 'DOCS_README', 'DOCS_INLINE'],
      });

      // batchId isn't a fixed fixture value — it's generated per call and
      // echoed back in the response, so assert against result.batchId
      // rather than hardcoding it, to prove the *same* id was used for both
      // documents, not just that insertMany received two arbitrary ones.
      expect(result.taskIds).toEqual(['task1', 'task2']);
      expect(typeof result.batchId).toBe('string');
      expect(taskModel.insertMany).toHaveBeenCalledWith([
        expect.objectContaining({
          operation: 'DOCS_README',
          batchId: result.batchId,
        }),
        expect.objectContaining({
          operation: 'DOCS_INLINE',
          batchId: result.batchId,
        }),
      ]);
      expect(queue.addBulk).toHaveBeenCalledWith([
        { name: 'run-task', data: { taskId: 'task1' } },
        { name: 'run-task', data: { taskId: 'task2' } },
      ]);
      // 2, not 3: the usage check is charged against the deduplicated
      // count — the same number of Tasks actually created — not the raw
      // request body.
      expect(usageLimit.checkAndIncrement).toHaveBeenCalledWith('user1', 2);
    });

    it('rejects with 429 when the monthly usage limit is exceeded, before creating anything', async () => {
      contextModel.findOne.mockResolvedValue({ _id: 'ctx1' });
      credentials.hasCredential.mockResolvedValue(true);
      agentRegistry.getForRole.mockReturnValue([
        {
          code: 'DOCS_README',
          displayName: '',
          description: '',
          agent: 'DOCS',
        },
      ]);
      usageLimit.checkAndIncrement.mockRejectedValue(
        Object.assign(new Error('limit exceeded'), {
          code: 'USAGE_LIMIT_EXCEEDED',
        }),
      );

      await expect(
        service.createBatch(developer, {
          contextId: 'ctx1',
          operations: ['DOCS_README'],
        }),
      ).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
      expect(taskModel.insertMany).not.toHaveBeenCalled();
      expect(queue.addBulk).not.toHaveBeenCalled();
    });
  });

  describe('findOneForUser', () => {
    it('throws NotFoundException when the task does not belong to the caller', async () => {
      taskModel.findOne.mockResolvedValue(null);

      await expect(service.findOneForUser('user1', 'task1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancel', () => {
    it('throws NotFoundException when the task does not belong to the caller', async () => {
      taskModel.findOne.mockResolvedValue(null);

      await expect(service.cancel('user1', 'task1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects with 409 when the task is already in a terminal state', async () => {
      taskModel.findOne.mockResolvedValue({
        status: 'COMPLETED',
        canTransitionTo: jest.fn().mockReturnValue(false),
      });

      await expect(service.cancel('user1', 'task1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('transitions to CANCELLED with a conditional write and emits task.updated', async () => {
      const task = {
        status: 'PENDING',
        canTransitionTo: jest.fn().mockReturnValue(true),
        save: jest.fn().mockResolvedValue(undefined),
      };
      taskModel.findOne.mockResolvedValue(task);

      await service.cancel('user1', 'task1');

      // The status filter is the point: a document fetched moments earlier
      // can't decide the race against a TaskProcessor invocation finishing
      // in between, so the transition is expressed as a filter the database
      // evaluates at write time.
      expect(taskModel.updateOne).toHaveBeenCalledWith(
        {
          _id: 'task1',
          userId: 'user1',
          status: { $in: ['PENDING', 'RUNNING'] },
        },
        { $set: { status: 'CANCELLED' } },
      );
      expect(task.save).not.toHaveBeenCalled();
      expect(events.emitTaskUpdated).toHaveBeenCalledWith(
        'user1',
        'task1',
        'CANCELLED',
      );
    });

    it('rejects with 409, and announces nothing, when the Task reached a terminal state before the write landed', async () => {
      // The Task was RUNNING when read, and TaskProcessor completed it
      // before this write got there. Cancelling it now would resurrect a
      // terminal Task, so the write matches nothing and the caller is told.
      taskModel.findOne.mockResolvedValue({
        status: 'RUNNING',
        canTransitionTo: jest.fn().mockReturnValue(true),
        save: jest.fn(),
      });
      taskModel.updateOne.mockResolvedValue({ matchedCount: 0 });

      await expect(service.cancel('user1', 'task1')).rejects.toThrow(
        ConflictException,
      );
      expect(events.emitTaskUpdated).not.toHaveBeenCalled();
    });
  });

  describe('submitInput', () => {
    function makeTask(overrides: Record<string, unknown> = {}) {
      return {
        id: 'task1',
        status: 'RUNNING',
        pendingInput: null,
        sprintId: undefined,
        canTransitionTo: jest.fn().mockReturnValue(true),
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it('throws NotFoundException when the task does not belong to the caller', async () => {
      taskModel.findOne.mockResolvedValue(null);

      await expect(
        service.submitInput('user1', 'task1', { kind: 'SPRINT_ID' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects with 409 when the task has no pending input', async () => {
      taskModel.findOne.mockResolvedValue(makeTask({ pendingInput: null }));

      await expect(
        service.submitInput('user1', 'task1', { kind: 'SPRINT_ID' } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects with 409 when the submitted kind does not match what the task is waiting for', async () => {
      taskModel.findOne.mockResolvedValue(
        makeTask({ pendingInput: { kind: 'BUSINESS_CONFIRMATION' } }),
      );

      await expect(
        service.submitInput('user1', 'task1', {
          kind: 'SPRINT_ID',
          sprintId: 'S-1',
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('SPRINT_ID: sets sprintId, clears pendingInput and enqueues a run-task job', async () => {
      const task = makeTask({ pendingInput: { kind: 'SPRINT_ID' } });
      taskModel.findOne.mockResolvedValue(task);

      await service.submitInput('user1', 'task1', {
        kind: 'SPRINT_ID',
        sprintId: 'S-42',
      } as never);

      expect(task.sprintId).toBe('S-42');
      expect(task.pendingInput).toBeNull();
      expect(task.save).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith('run-task', { taskId: 'task1' });
    });

    it('INCOMPLETE_TASKS + PROCEED: clears pendingInput and enqueues a resume-task job', async () => {
      const task = makeTask({
        pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['T-1'] },
      });
      taskModel.findOne.mockResolvedValue(task);

      await service.submitInput('user1', 'task1', {
        kind: 'INCOMPLETE_TASKS',
        action: 'PROCEED',
      } as never);

      expect(task.pendingInput).toBeNull();
      expect(queue.add).toHaveBeenCalledWith('resume-task', {
        taskId: 'task1',
        inputValue: { action: 'PROCEED' },
      });
      expect(events.emitTaskUpdated).not.toHaveBeenCalled();
    });

    it('BUSINESS_CONFIRMATION + CANCEL: cancels the task instead of resuming the agent', async () => {
      const task = makeTask({
        pendingInput: {
          kind: 'BUSINESS_CONFIRMATION',
          technicalReportId: 'r1',
        },
      });
      taskModel.findOne.mockResolvedValue(task);

      await service.submitInput('user1', 'task1', {
        kind: 'BUSINESS_CONFIRMATION',
        action: 'CANCEL',
      } as never);

      // Same conditional write POST /tasks/:id/cancel uses — it is the same
      // transition — plus clearing the pendingInput this answer resolves.
      expect(taskModel.updateOne).toHaveBeenCalledWith(
        {
          _id: 'task1',
          userId: 'user1',
          status: { $in: ['PENDING', 'RUNNING'] },
        },
        { $set: { status: 'CANCELLED', pendingInput: null } },
      );
      expect(task.save).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(events.emitTaskUpdated).toHaveBeenCalledWith(
        'user1',
        'task1',
        'CANCELLED',
      );
    });
  });
});

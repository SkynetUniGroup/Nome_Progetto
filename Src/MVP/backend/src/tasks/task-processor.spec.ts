import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { TaskProcessor } from './task-processor';
import { Task } from './schemas/task.schema';
import { EventsGateway } from '../events/events.gateway';
import { AgentInvocationService } from './agent-invocation.service';
import { AgentRegistry } from '../operations/agent-registry.service';
import { ReportAssemblyService } from '../reports/report-assembly.service';

// Frozen clock, so every write this class makes is assertable by value
// instead of through a matcher: process() reads Date.now() once to claim
// and twice around the invocation, and with the clock held still the
// elapsed time is 0 and accumulatedMs stays put — except in the two timing
// tests below, which drive their own sequence.
const NOW = 1_700_000_000_000;
// Mirrors CLAIM_LEASE_MS in task-processor.ts. Duplicated on purpose: if
// someone shortens the lease there, the claim-filter test below should fail
// and make them think about whether the new window is still safely above
// the agent's own 300s ceiling, rather than silently following along.
const CLAIM_LEASE_MS = 10 * 60 * 1000;

describe('TaskProcessor', () => {
  let processor: TaskProcessor;
  let taskModel: {
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
    countDocuments: jest.Mock;
  };
  let events: {
    emitTaskUpdated: jest.Mock;
    emitTaskFailed: jest.Mock;
    emitTaskInputRequired: jest.Mock;
    emitBatchCompleted: jest.Mock;
  };
  let agentInvocation: { invoke: jest.Mock; resume: jest.Mock };
  let agentRegistry: { getAgent: jest.Mock };
  let reportAssembly: {
    assembleCompleted: jest.Mock;
    assembleFailed: jest.Mock;
    discard: jest.Mock;
  };
  let clock: jest.SpyInstance<number, []>;

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      _id: 'task-oid',
      id: 'task1',
      userId: 'user1',
      batchId: 'batchA',
      operation: 'DOCS_README',
      status: 'PENDING',
      error: null,
      reportId: null,
      pendingInput: null,
      sprintId: undefined,
      accumulatedMs: 0,
      processingClaimedAt: null,
      canTransitionTo: jest.fn().mockReturnValue(true),
      // Kept on the fixture purely so the "no state change goes through
      // save()" assertions below have something that would have been called
      // if the class regressed to mutate-then-save.
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function completed() {
    return { status: 'COMPLETED', payload: { body: [] } };
  }

  // The claim is what hands process() its Task — a test that wants the job
  // to actually run says so here.
  function claimSucceeds(task: unknown) {
    taskModel.findOneAndUpdate.mockResolvedValue(task);
  }

  // The fencing token this run's claim minted, read back off the claim call
  // itself. Asserting against this rather than expect.any(String) is the
  // point: every later write has to carry the token of the claim that is
  // actually held, not merely some string.
  function claimToken(call = 0): string {
    const claims = taskModel.findOneAndUpdate.mock.calls as [
      unknown,
      { $set: { processingClaimToken: string } },
    ][];
    return claims[call][1].$set.processingClaimToken;
  }

  beforeEach(async () => {
    taskModel = {
      findOneAndUpdate: jest.fn(),
      // Every conditional write matches by default; the tests about losing
      // a race override this per call.
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      // No other task left active in the batch, by default — most tests
      // only care about the single task's own transition, not the tally.
      countDocuments: jest.fn().mockResolvedValue(0),
    };
    events = {
      emitTaskUpdated: jest.fn(),
      emitTaskFailed: jest.fn(),
      emitTaskInputRequired: jest.fn(),
      emitBatchCompleted: jest.fn(),
    };
    agentInvocation = { invoke: jest.fn(), resume: jest.fn() };
    // DOCS by default — most tests don't care about the Changelog/sprintId
    // pre-check, only the ones under 'BE-17 pause/resume' below do, and they
    // override this per-test.
    agentRegistry = { getAgent: jest.fn().mockReturnValue('DOCS') };
    reportAssembly = {
      assembleCompleted: jest.fn().mockResolvedValue({ _id: 'report1' }),
      assembleFailed: jest.fn().mockResolvedValue({ _id: 'report1' }),
      discard: jest.fn().mockResolvedValue(undefined),
    };
    clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        { provide: getModelToken(Task.name), useValue: taskModel },
        { provide: EventsGateway, useValue: events },
        { provide: AgentInvocationService, useValue: agentInvocation },
        { provide: AgentRegistry, useValue: agentRegistry },
        { provide: ReportAssemblyService, useValue: reportAssembly },
      ],
    }).compile();

    processor = module.get(TaskProcessor);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  function job(
    data: { taskId: string; inputValue?: unknown } = { taskId: 'task1' },
  ) {
    return { data } as never;
  }

  describe('claiming', () => {
    // What a unit test can and cannot show here: mutual exclusion is
    // MongoDB's guarantee, not something a mocked model can demonstrate.
    // What these tests do pin down is the half that lives in this codebase
    // — that the exclusivity is actually asked for, in the filter, where
    // the database can enforce it, and that losing the claim is handled by
    // doing nothing at all.
    it('claims the Task atomically before anything else, with a filter a second delivery cannot also match', async () => {
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      expect(taskModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'task1',
          status: { $in: ['PENDING', 'RUNNING'] },
          $or: [
            { processingClaimedAt: null },
            // A claim older than the lease is treated as abandoned, so a
            // worker killed mid-invocation doesn't strand the Task.
            { processingClaimedAt: { $lte: new Date(NOW - CLAIM_LEASE_MS) } },
          ],
        },
        {
          $set: {
            processingClaimedAt: new Date(NOW),
            // Minted per claim — a takeover of a stale claim included — so
            // that the writes below can prove which claim they belong to.
            // The value itself is read back off this very call: what this
            // assertion pins is that the claim writes a token *and nothing
            // else* beside the timestamp. That the token is distinct per
            // claim, and that later writes carry the right one, is the
            // separate test below.
            processingClaimToken: claimToken(),
          },
        },
        { new: true },
      );
      expect(claimToken()).toEqual(expect.any(String));
    });

    it('does nothing at all when the claim comes back empty — gone, terminal, or held by another delivery', async () => {
      taskModel.findOneAndUpdate.mockResolvedValue(null);

      await processor.process(job());

      expect(agentInvocation.invoke).not.toHaveBeenCalled();
      expect(agentInvocation.resume).not.toHaveBeenCalled();
      expect(taskModel.updateOne).not.toHaveBeenCalled();
      expect(events.emitTaskUpdated).not.toHaveBeenCalled();
      expect(events.emitTaskFailed).not.toHaveBeenCalled();
    });

    it('releases the claim once the job is done, so a later resume job can take it', async () => {
      claimSucceeds(makeTask());
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      expect(taskModel.updateOne).toHaveBeenLastCalledWith(
        { _id: 'task-oid', processingClaimToken: claimToken() },
        { $set: { processingClaimedAt: null, processingClaimToken: null } },
      );
    });

    it('releases the claim even when the invocation throws', async () => {
      claimSucceeds(makeTask());
      agentInvocation.invoke.mockRejectedValue(new Error('network down'));

      await processor.process(job());

      expect(taskModel.updateOne).toHaveBeenLastCalledWith(
        { _id: 'task-oid', processingClaimToken: claimToken() },
        { $set: { processingClaimedAt: null, processingClaimToken: null } },
      );
    });

    // The release filter is the whole point of the token: without it, the
    // first expired lease permanently breaks exclusivity, because the
    // worker that lost the claim still clears the one its successor holds.
    it('releases only its own claim — a worker whose lease expired clears nothing', async () => {
      const task = makeTask();
      taskModel.findOneAndUpdate
        .mockResolvedValueOnce(task) // A claims
        .mockResolvedValueOnce(task); // B takes over after A's lease expires
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());
      await processor.process(job());

      // Two different claims, so two different tokens...
      expect(claimToken(0)).not.toBe(claimToken(1));
      // ...and each release names its own.
      const writes = taskModel.updateOne.mock.calls as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ][];
      const releases = writes.filter(
        ([, update]) => update.$set.processingClaimToken === null,
      );
      expect(releases).toHaveLength(2);
      expect(releases[0][0]).toEqual({
        _id: 'task-oid',
        processingClaimToken: claimToken(0),
      });
      expect(releases[1][0]).toEqual({
        _id: 'task-oid',
        processingClaimToken: claimToken(1),
      });
    });

    it('does not fail the job when releasing the claim fails — the lease covers that case instead', async () => {
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.invoke.mockResolvedValue(completed());
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 1 }) // terminal write
        .mockRejectedValueOnce(new Error('mongo down')); // the release

      await expect(processor.process(job())).resolves.toBeUndefined();
    });

    it('never routes a state change through document.save()', async () => {
      const task = makeTask();
      claimSucceeds(task);
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      // save() writes the paths touched in memory without checking what the
      // database holds now, which is what let a completing invocation
      // overwrite a concurrent cancel. Every write here must be conditional.
      expect(task.save).not.toHaveBeenCalled();
    });
  });

  it('transitions PENDING to RUNNING with a conditional write and emits task.updated before invoking the agent', async () => {
    claimSucceeds(makeTask());
    agentInvocation.invoke.mockResolvedValue(completed());

    await processor.process(job());

    expect(taskModel.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        _id: 'task-oid',
        status: 'PENDING',
        processingClaimToken: claimToken(),
      },
      { $set: { status: 'RUNNING' } },
    );
    expect(events.emitTaskUpdated).toHaveBeenCalledWith(
      'user1',
      'task1',
      'RUNNING',
    );
  });

  it('skips the invocation entirely when the Task is cancelled between the claim and the RUNNING transition', async () => {
    claimSucceeds(makeTask());
    taskModel.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 }) // no longer PENDING
      .mockResolvedValue({ matchedCount: 1 });

    await processor.process(job());

    expect(agentInvocation.invoke).not.toHaveBeenCalled();
    expect(events.emitTaskUpdated).not.toHaveBeenCalled();
    // Still released, even on this early exit.
    expect(taskModel.updateOne).toHaveBeenLastCalledWith(
      { _id: 'task-oid', processingClaimToken: claimToken() },
      { $set: { processingClaimedAt: null, processingClaimToken: null } },
    );
  });

  describe('BE-18 report assembly', () => {
    it('assembles a Report on COMPLETED, persists it conditionally, and includes its id in task.updated', async () => {
      const task = makeTask();
      claimSucceeds(task);
      const payload = { body: [{ kind: 'TEXT', markdown: 'hi' }] };
      agentInvocation.invoke.mockResolvedValue({
        status: 'COMPLETED',
        payload,
      });

      await processor.process(job());

      expect(reportAssembly.assembleCompleted).toHaveBeenCalledWith(
        task,
        payload,
      );
      expect(taskModel.updateOne).toHaveBeenNthCalledWith(
        2,
        {
          _id: 'task-oid',
          status: 'RUNNING',
          processingClaimToken: claimToken(),
        },
        {
          $set: {
            status: 'COMPLETED',
            reportId: 'report1',
            accumulatedMs: 0,
          },
        },
      );
      expect(events.emitTaskUpdated).toHaveBeenCalledWith(
        'user1',
        'task1',
        'COMPLETED',
        'report1',
      );
    });

    it('assembles a Report on FAILED and records the error in the same conditional write', async () => {
      const task = makeTask();
      claimSucceeds(task);
      const error = {
        code: 'UPSTREAM' as const,
        message: 'boom',
        stage: 'EXECUTION',
      };
      agentInvocation.invoke.mockResolvedValue({ status: 'FAILED', error });

      await processor.process(job());

      expect(reportAssembly.assembleFailed).toHaveBeenCalledWith(task, error);
      expect(taskModel.updateOne).toHaveBeenNthCalledWith(
        2,
        {
          _id: 'task-oid',
          status: 'RUNNING',
          processingClaimToken: claimToken(),
        },
        {
          $set: {
            status: 'FAILED',
            error,
            reportId: 'report1',
            accumulatedMs: 0,
          },
        },
      );
      expect(events.emitTaskFailed).toHaveBeenCalledWith(
        'user1',
        'task1',
        error,
      );
    });

    it('synthesizes a generic error and still assembles a Report if a FAILED result carries none', async () => {
      claimSucceeds(makeTask());
      agentInvocation.invoke.mockResolvedValue({ status: 'FAILED' });

      await processor.process(job());

      expect(reportAssembly.assembleFailed).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ code: 'UPSTREAM' }),
      );
    });

    it('assembles a FAILED Report even when the invocation throws, without letting the error escape', async () => {
      claimSucceeds(makeTask());
      agentInvocation.invoke.mockRejectedValue(new Error('network down'));

      await expect(processor.process(job())).resolves.toBeUndefined();

      expect(reportAssembly.assembleFailed).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ message: 'network down' }),
      );
      expect(events.emitTaskFailed).toHaveBeenCalled();
    });

    it('accumulates machine time across the call and never resets it', async () => {
      const task = makeTask({ accumulatedMs: 1000 });
      claimSucceeds(task);
      clock
        .mockReturnValueOnce(4_000) // the claim's own clock read
        .mockReturnValueOnce(5_000) // startedAt
        .mockReturnValueOnce(5_300); // after the (mocked, instant) invoke
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      expect(task.accumulatedMs).toBe(1300); // 1000 already there + 300 this call
    });

    // The test above only proves a single process() call adds to whatever
    // accumulatedMs already had — it seeds that starting value through the
    // task fixture rather than actually producing it. BE-18 requires the
    // sum to survive a real pause: this drives the same Task object through
    // two separate process() calls — first a SPRINT_ID pause (no agent
    // call at all), then the resumption once sprintId is answered — and
    // asserts the second call's contribution lands on top of the first's
    // rather than either overwriting it or double-counting the gap between
    // them.
    it('sums machine time across a real SPRINT_ID pause/resume cycle, excluding the gap between the two calls', async () => {
      const task = makeTask({ operation: 'CHANGELOG_TECHNICAL' });
      claimSucceeds(task);
      agentRegistry.getAgent.mockReturnValue('CHANGELOG');

      clock
        .mockReturnValueOnce(900) // call 1: claim
        .mockReturnValueOnce(1_000) // call 1: startedAt
        .mockReturnValueOnce(1_200); // call 1: after the SPRINT_ID pause

      await processor.process(job());

      expect(agentInvocation.invoke).not.toHaveBeenCalled();
      expect(task.pendingInput).toEqual({ kind: 'SPRINT_ID' });
      expect(task.accumulatedMs).toBe(200); // only this call's own 200ms

      // Between the two calls: what TasksService.submitInput does once the
      // user answers SPRINT_ID — clears pendingInput, sets sprintId, leaves
      // status RUNNING. This gap must never be added to accumulatedMs.
      task.sprintId = 'S-1';
      task.pendingInput = null;
      task.status = 'RUNNING';

      clock
        .mockReturnValueOnce(49_000) // call 2: claim, far later
        .mockReturnValueOnce(50_000) // call 2: startedAt
        .mockReturnValueOnce(50_450); // call 2: after invoke() resolves
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      expect(agentInvocation.invoke).toHaveBeenCalledWith(task);
      // 200 (call 1) + 450 (call 2) — never reset by the pause, and the
      // ~48-second gap between the two clock sequences (standing in for the
      // real wall-clock time spent waiting on user input) contributes
      // nothing.
      expect(task.accumulatedMs).toBe(650);
    });
  });

  // The second race the conditional writes exist for: a cancel that lands
  // while the agent is mid-invocation. Before, the completing invocation
  // save()d its own result over it — the user's cancel was accepted, the
  // frontend was told CANCELLED, and then the Task quietly became COMPLETED
  // anyway.
  describe('cancel landing mid-invocation', () => {
    it('does not overwrite the cancel, and stays silent about the result it can no longer apply', async () => {
      const task = makeTask({ status: 'RUNNING' });
      claimSucceeds(task);
      agentInvocation.resume.mockResolvedValue(completed());
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 }) // no longer RUNNING
        .mockResolvedValue({ matchedCount: 1 }); // the release still works

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(events.emitTaskUpdated).not.toHaveBeenCalled();
      expect(task.status).toBe('RUNNING'); // never mirrored to COMPLETED locally either
    });

    // The Report assembled just before the conditional write is not an
    // unreferenced row waiting to be garbage collected: the pointer runs
    // Report -> Task, and GET /reports filters on userId alone, so leaving
    // it puts a COMPLETED report of this execution in the user's list right
    // beside the CANCELLED Task it belongs to.
    it('deletes the Report it just assembled, by id, when the write does not land', async () => {
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.resume.mockResolvedValue(completed());
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValue({ matchedCount: 1 });

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(reportAssembly.discard).toHaveBeenCalledWith({ _id: 'report1' });
    });

    it('deletes the FAILED Report the same way', async () => {
      // A FAILED Report is exactly as visible in GET /reports as a
      // COMPLETED one, so this branch cannot be the tidy one.
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.resume.mockResolvedValue({
        status: 'FAILED',
        error: { code: 'UPSTREAM', message: 'boom', stage: 'EXECUTION' },
      });
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValue({ matchedCount: 1 });

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(reportAssembly.discard).toHaveBeenCalledWith({ _id: 'report1' });
    });

    it('keeps the Report when the write does land', async () => {
      // The counterweight: the deletion is conditioned on losing the race,
      // not on assembling a Report.
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.resume.mockResolvedValue(completed());

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(reportAssembly.discard).not.toHaveBeenCalled();
    });

    it('does not fail the job when deleting the orphaned Report fails', async () => {
      // Same rule as releaseClaim, and RF.48: the job's own outcome is
      // already settled by this point, and a failed cleanup is worth a log,
      // not a discarded job.
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.resume.mockResolvedValue(completed());
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValue({ matchedCount: 1 });
      reportAssembly.discard.mockRejectedValue(new Error('mongo down'));

      await expect(
        processor.process(
          job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
        ),
      ).resolves.toBeUndefined();
    });

    it('assembles no Report at all for a pause it could not record', async () => {
      // An INTERRUPTED result never builds one, so there is nothing to
      // delete on that path — asserted so the deletion above is not quietly
      // generalized into "delete something on every lost race".
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.resume.mockResolvedValue({
        status: 'INTERRUPTED',
        pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['T-1'] },
      });
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValue({ matchedCount: 1 });

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(reportAssembly.assembleCompleted).not.toHaveBeenCalled();
      expect(reportAssembly.assembleFailed).not.toHaveBeenCalled();
      expect(reportAssembly.discard).not.toHaveBeenCalled();
    });

    it('does not announce a failure it could not record either', async () => {
      const task = makeTask({ status: 'RUNNING' });
      claimSucceeds(task);
      agentInvocation.resume.mockResolvedValue({
        status: 'FAILED',
        error: { code: 'UPSTREAM', message: 'boom', stage: 'EXECUTION' },
      });
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValue({ matchedCount: 1 });

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(events.emitTaskFailed).not.toHaveBeenCalled();
    });

    it('does not announce a pause it could not record either', async () => {
      const task = makeTask({ status: 'RUNNING' });
      claimSucceeds(task);
      agentInvocation.resume.mockResolvedValue({
        status: 'INTERRUPTED',
        pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['T-1'] },
      });
      taskModel.updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValue({ matchedCount: 1 });

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(events.emitTaskInputRequired).not.toHaveBeenCalled();
      expect(task.pendingInput).toBeNull();
    });
  });

  // BullMQ delivers at-least-once: the same job can be handed out twice
  // (worker restart, expired lock, several replicas). Before the claim, the
  // second delivery read a Task that the first had already moved to
  // RUNNING, took the BE-17 fallthrough meant for continuations/resumes,
  // and invoked the agent a second time — double cost now, and a double
  // Pull Request later once BE-9 is wired in.
  describe('duplicate job delivery', () => {
    it('invokes the agent once when the same job is delivered twice and the second loses the claim', async () => {
      const task = makeTask();
      taskModel.findOneAndUpdate
        .mockResolvedValueOnce(task) // first delivery takes the claim
        .mockResolvedValueOnce(null); // second finds it held
      agentInvocation.invoke.mockResolvedValue(completed());

      // Neither call is awaited individually — both start before either
      // resolves, like two workers picking up the same job id.
      const first = processor.process(job());
      const second = processor.process(job());
      await Promise.all([first, second]);

      expect(agentInvocation.invoke).toHaveBeenCalledTimes(1);
      expect(reportAssembly.assembleCompleted).toHaveBeenCalledTimes(1);
      expect(events.emitTaskUpdated).toHaveBeenCalledTimes(2); // RUNNING + COMPLETED, once each
    });
  });

  it('does not emit batch.completed while sibling Tasks in the batch are still active', async () => {
    claimSucceeds(makeTask());
    agentInvocation.invoke.mockResolvedValue({ status: 'FAILED', error: {} });
    taskModel.countDocuments.mockResolvedValueOnce(2); // still active

    await processor.process(job());

    expect(events.emitBatchCompleted).not.toHaveBeenCalled();
  });

  it('emits batch.completed with the tally once no sibling Task is still active', async () => {
    claimSucceeds(makeTask());
    agentInvocation.invoke.mockResolvedValue(completed());
    taskModel.countDocuments
      .mockResolvedValueOnce(0) // none PENDING/RUNNING
      .mockResolvedValueOnce(3) // COMPLETED
      .mockResolvedValueOnce(1); // FAILED/CANCELLED

    await processor.process(job());

    expect(events.emitBatchCompleted).toHaveBeenCalledWith(
      'user1',
      'batchA',
      3,
      1,
    );
  });

  describe('BE-17 pause/resume', () => {
    it('pauses a fresh Changelog Task on SPRINT_ID without ever calling the agent', async () => {
      const task = makeTask({ operation: 'CHANGELOG_TECHNICAL' });
      claimSucceeds(task);
      agentRegistry.getAgent.mockReturnValue('CHANGELOG');

      await processor.process(job());

      expect(agentInvocation.invoke).not.toHaveBeenCalled();
      // The pause is a write on a still-RUNNING Task — no terminal status,
      // just the pendingInput the frontend needs to raise its modal, plus
      // the release of the claim: a paused Task is by definition not being
      // worked on, and the answer this pause is about to ask for arrives as
      // a job that has to be able to claim it.
      expect(taskModel.updateOne).toHaveBeenNthCalledWith(
        2,
        {
          _id: 'task-oid',
          status: 'RUNNING',
          processingClaimToken: claimToken(),
        },
        {
          $set: {
            pendingInput: { kind: 'SPRINT_ID' },
            accumulatedMs: 0,
            processingClaimedAt: null,
            processingClaimToken: null,
          },
        },
      );
      expect(events.emitTaskInputRequired).toHaveBeenCalledWith(
        'user1',
        'task1',
        { kind: 'SPRINT_ID' },
      );
      expect(events.emitTaskFailed).not.toHaveBeenCalled();
    });

    it('invokes the agent for a Changelog Task once sprintId is already set', async () => {
      const task = makeTask({
        operation: 'CHANGELOG_TECHNICAL',
        sprintId: 'S-12',
      });
      claimSucceeds(task);
      agentRegistry.getAgent.mockReturnValue('CHANGELOG');
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      expect(agentInvocation.invoke).toHaveBeenCalledWith(task);
    });

    it('proceeds straight to invoke() for a Changelog Task already RUNNING with sprintId just answered, without re-emitting task.updated RUNNING', async () => {
      // The second 'run-task' delivery, after TasksService.submitInput set
      // sprintId and cleared pendingInput but left status RUNNING.
      const task = makeTask({
        operation: 'CHANGELOG_TECHNICAL',
        status: 'RUNNING',
        sprintId: 'S-12',
      });
      claimSucceeds(task);
      agentRegistry.getAgent.mockReturnValue('CHANGELOG');
      agentInvocation.invoke.mockResolvedValue(completed());

      await processor.process(job());

      expect(agentInvocation.invoke).toHaveBeenCalledWith(task);
      expect(events.emitTaskUpdated).toHaveBeenCalledTimes(1); // only COMPLETED
      expect(events.emitTaskUpdated).toHaveBeenCalledWith(
        'user1',
        'task1',
        'COMPLETED',
        'report1',
      );
    });

    it('sets pendingInput and emits task.inputRequired when the agent itself reports INTERRUPTED', async () => {
      const task = makeTask();
      claimSucceeds(task);
      const pendingInput = {
        kind: 'INCOMPLETE_TASKS' as const,
        taskIds: ['T-1'],
      };
      agentInvocation.invoke.mockResolvedValue({
        status: 'INTERRUPTED',
        pendingInput,
      });

      await processor.process(job());

      expect(task.pendingInput).toEqual(pendingInput);
      expect(events.emitTaskInputRequired).toHaveBeenCalledWith(
        'user1',
        'task1',
        pendingInput,
      );
      expect(reportAssembly.assembleCompleted).not.toHaveBeenCalled();
      expect(reportAssembly.assembleFailed).not.toHaveBeenCalled();
    });

    it('routes a job carrying inputValue to agentInvocation.resume(), not invoke()', async () => {
      const task = makeTask({ status: 'RUNNING' });
      claimSucceeds(task);
      agentInvocation.resume.mockResolvedValue(completed());

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(agentInvocation.resume).toHaveBeenCalledWith(task, {
        action: 'PROCEED',
      });
      expect(agentInvocation.invoke).not.toHaveBeenCalled();
    });

    it('skips a resume-task job for a Task that is no longer claimable (e.g. cancelled meanwhile)', async () => {
      // A cancelled Task fails the claim filter's status check, so the
      // resume never gets a document to work with in the first place.
      taskModel.findOneAndUpdate.mockResolvedValue(null);

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(agentInvocation.resume).not.toHaveBeenCalled();
      expect(taskModel.updateOne).not.toHaveBeenCalled();
    });

    it('does not transition or re-emit task.updated RUNNING for a resume-task job on an already-RUNNING Task', async () => {
      claimSucceeds(makeTask({ status: 'RUNNING' }));
      agentInvocation.resume.mockResolvedValue({
        status: 'FAILED',
        error: { code: 'UPSTREAM', message: 'boom', stage: 'EXECUTION' },
      });

      await processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );

      expect(events.emitTaskUpdated).not.toHaveBeenCalled();
    });
  });
});

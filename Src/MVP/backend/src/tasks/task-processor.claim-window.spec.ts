import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { TaskProcessor } from './task-processor';
import { Task } from './schemas/task.schema';
import { EventsGateway } from '../events/events.gateway';
import { AgentInvocationService } from './agent-invocation.service';
import { AgentRegistry } from '../operations/agent-registry.service';
import { ReportAssemblyService } from '../reports/report-assembly.service';

// These tests are written against the requirement, not the implementation.
//
// BE-17 says POST /tasks/:id/input "azzera pendingInput, e avvia l'agente
// per la prima volta, ne riprende l'esecuzione, oppure annulla il task" —
// answering a pending input must actually start or resume the agent. BE-13
// says a Task's lifecycle ends in COMPLETED/FAILED/CANCELLED. Neither
// permits a Task that sits in RUNNING forever with the user's answer
// already accepted.
//
// The existing task-processor.spec.ts asserts the shape of the queries the
// claim mechanism issues, with findOneAndUpdate/updateOne mocked to canned
// answers. That can show the filter is *asked for*; it cannot show what the
// mechanism does across two overlapping deliveries, because a canned mock
// has no state for one delivery to observe the other through. The fake
// below keeps that state and actually evaluates the filters TaskProcessor
// writes, so a claim genuinely excludes a second holder and a release
// genuinely frees it.

interface StoredTask {
  _id: string;
  id: string;
  userId: string;
  batchId: string;
  operation: string;
  status: string;
  error: unknown;
  reportId: unknown;
  pendingInput: unknown;
  sprintId?: string;
  accumulatedMs: number;
  processingClaimedAt: Date | null;
  [key: string]: unknown;
}

/** Only the operators TaskProcessor's own filters use. */
function matches(doc: StoredTask, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return (expected as Record<string, unknown>[]).some((sub) =>
        matches(doc, sub),
      );
    }
    const actual = doc[key];
    if (expected !== null && typeof expected === 'object') {
      const ops = expected as Record<string, unknown>;
      if ('$in' in ops) {
        return (ops.$in as unknown[]).includes(actual);
      }
      if ('$lte' in ops) {
        return actual instanceof Date && actual <= (ops.$lte as Date);
      }
      throw new Error(`unsupported operator in filter: ${JSON.stringify(ops)}`);
    }
    return actual === expected;
  });
}

class FakeTaskCollection {
  constructor(private readonly docs: StoredTask[]) {}

  findOneAndUpdate = jest.fn(
    (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => {
      const doc = this.docs.find((d) => matches(d, filter));
      if (!doc) {
        return Promise.resolve(null);
      }
      Object.assign(doc, update.$set);
      // findOneAndUpdate({new: true}) hands the processor a hydrated
      // document; a copy stands in for it, so the processor's in-memory
      // mutations don't leak back into the store the way only a real
      // conditional write should.
      return Promise.resolve({
        ...doc,
        save: jest.fn().mockResolvedValue(undefined),
      });
    },
  );

  updateOne = jest.fn(
    (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => {
      const doc = this.docs.find((d) => matches(d, filter));
      if (!doc) {
        return Promise.resolve({ matchedCount: 0 });
      }
      Object.assign(doc, update.$set);
      return Promise.resolve({ matchedCount: 1 });
    },
  );

  countDocuments = jest.fn((filter: Record<string, unknown>) =>
    Promise.resolve(this.docs.filter((d) => matches(d, filter)).length),
  );

  get(id: string): StoredTask {
    const doc = this.docs.find((d) => d._id === id);
    if (!doc) {
      throw new Error(`no task ${id}`);
    }
    return doc;
  }
}

function makeStored(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    _id: 'task1',
    id: 'task1',
    userId: 'user1',
    batchId: 'batchA',
    operation: 'CHANGELOG_TECHNICAL',
    status: 'PENDING',
    error: null,
    reportId: null,
    pendingInput: null,
    sprintId: undefined,
    accumulatedMs: 0,
    processingClaimedAt: null,
    ...overrides,
  };
}

describe('TaskProcessor — the window between announcing and releasing', () => {
  let processor: TaskProcessor;
  let store: FakeTaskCollection;
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
  };

  async function build(docs: StoredTask[]) {
    store = new FakeTaskCollection(docs);
    events = {
      emitTaskUpdated: jest.fn(),
      emitTaskFailed: jest.fn(),
      emitTaskInputRequired: jest.fn(),
      emitBatchCompleted: jest.fn(),
    };
    agentInvocation = { invoke: jest.fn(), resume: jest.fn() };
    agentRegistry = { getAgent: jest.fn().mockReturnValue('CHANGELOG') };
    reportAssembly = {
      assembleCompleted: jest.fn().mockResolvedValue({ _id: 'report1' }),
      assembleFailed: jest.fn().mockResolvedValue({ _id: 'report1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        { provide: getModelToken(Task.name), useValue: store },
        { provide: EventsGateway, useValue: events },
        { provide: AgentInvocationService, useValue: agentInvocation },
        { provide: AgentRegistry, useValue: agentRegistry },
        { provide: ReportAssemblyService, useValue: reportAssembly },
      ],
    }).compile();

    processor = module.get(TaskProcessor);
  }

  function job(data: { taskId: string; inputValue?: unknown }) {
    return { data } as never;
  }

  it('starts the agent when the user answers a SPRINT_ID pause before the claim is released', async () => {
    // BE-17's first legitimate case: a Changelog Task with no sprintId
    // pauses without ever calling the agent, the frontend gets
    // task.inputRequired, the user answers, and POST /tasks/:id/input
    // re-enqueues the same {taskId} job so the agent finally starts.
    await build([makeStored()]);

    let resumeDelivery: Promise<void> | undefined;
    // The answer arrives as fast as the user's client can produce it —
    // which is to say, while process() is still finishing up. The emit is
    // the moment the frontend learns it has something to answer, so it is
    // the earliest point the reply can be produced; everything process()
    // does after it is window.
    events.emitTaskInputRequired.mockImplementation(() => {
      // What TasksService.submitInput does for SPRINT_ID: record the
      // answer, clear pendingInput, enqueue the same job shape.
      const doc = store.get('task1');
      doc.sprintId = 'SPRINT-42';
      doc.pendingInput = null;
      resumeDelivery = processor.process(job({ taskId: 'task1' }));
    });

    agentInvocation.invoke.mockResolvedValue({
      status: 'COMPLETED',
      payload: { body: [] },
    });

    await processor.process(job({ taskId: 'task1' }));
    await resumeDelivery;

    const task = store.get('task1');

    // The requirement: the answer starts the agent.
    expect(agentInvocation.invoke).toHaveBeenCalledTimes(1);
    // ...and the Task reaches a terminal state rather than sitting in
    // RUNNING with the user's answer already consumed and no pendingInput
    // left to re-announce.
    expect(task.status).not.toBe('RUNNING');
    expect(task.pendingInput).toBeNull();
  });

  it('resumes the agent when the user answers an agent-reported INCOMPLETE_TASKS pause the same way', async () => {
    // BE-17's second legitimate case: the agent itself pauses mid-run and
    // POST /tasks/:id/input enqueues a resume-task job carrying inputValue.
    await build([makeStored({ sprintId: 'SPRINT-42' })]);

    agentInvocation.invoke.mockResolvedValue({
      status: 'INTERRUPTED',
      pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['ISS-1'] },
    });
    agentInvocation.resume.mockResolvedValue({
      status: 'COMPLETED',
      payload: { body: [] },
    });

    let resumeDelivery: Promise<void> | undefined;
    events.emitTaskInputRequired.mockImplementation(() => {
      const doc = store.get('task1');
      doc.pendingInput = null;
      resumeDelivery = processor.process(
        job({ taskId: 'task1', inputValue: { action: 'PROCEED' } }),
      );
    });

    await processor.process(job({ taskId: 'task1' }));
    await resumeDelivery;

    const task = store.get('task1');

    expect(agentInvocation.resume).toHaveBeenCalledTimes(1);
    expect(task.status).not.toBe('RUNNING');
  });

  it('does not let a worker whose lease expired release the claim its successor now holds', async () => {
    // The lease exists so a Task whose worker died mid-invocation becomes
    // processable again. Once a takeover has happened, the original worker
    // finishing must not hand the Task to a third delivery while the
    // successor is still invoking the agent — that is the same double
    // invocation the claim was introduced to prevent, just reached by a
    // different route.
    await build([
      makeStored({ operation: 'DOCS_README', sprintId: undefined }),
    ]);
    agentRegistry.getAgent.mockReturnValue('DOCS');

    const T0 = 1_700_000_000_000;
    const LEASE_MS = 10 * 60 * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);

    // Worker A claims and is still inside the agent call.
    let releaseA: () => void = () => undefined;
    agentInvocation.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseA = () =>
            resolve({ status: 'COMPLETED', payload: { body: [] } });
        }),
    );
    const workerA = processor.process(job({ taskId: 'task1' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Long enough that A's claim looks abandoned. Worker B takes over and
    // is now the legitimate holder, still invoking.
    clock.mockReturnValue(T0 + LEASE_MS + 1000);
    let releaseB: () => void = () => undefined;
    agentInvocation.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseB = () =>
            resolve({ status: 'COMPLETED', payload: { body: [] } });
        }),
    );
    const workerB = processor.process(job({ taskId: 'task1' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A now finishes and runs its finally.
    releaseA();
    await workerA;

    // With B still in flight, the Task must not be claimable by anyone
    // else: B holds the lease and its invocation is alive.
    const afterA = store.get('task1').processingClaimedAt;
    expect(afterA).not.toBeNull();

    releaseB();
    await workerB;
    clock.mockRestore();
  });
});

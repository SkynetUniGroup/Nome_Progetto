import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import { Task, TaskDocument } from './schemas/task.schema';
import {
  AgentInvocationResult,
  AgentInvocationService,
} from './agent-invocation.service';
import { AgentRunPayload } from './agent-client.types';
import { TaskError } from './task.types';
import { AgentRegistry } from '../operations/agent-registry.service';
import { EventsGateway } from '../events/events.gateway';
import { ReportAssemblyService } from '../reports/report-assembly.service';
import { ReportDocument } from '../reports/schemas/report.schema';

// Two job shapes on the same 'tasks' queue: a plain {taskId} is either a
// brand-new PENDING pickup, or (BE-17) a Changelog Task whose sprintId was
// just answered — both reach startOrPause() below and it's the Task's own
// status/sprintId that tells them apart, not the job. {taskId, inputValue}
// is a resume: an already-RUNNING Task whose INCOMPLETE_TASKS or
// BUSINESS_CONFIRMATION pendingInput was just cleared by
// TasksService.submitInput, carrying whatever the agent should be resumed
// with.
export type RunTaskJobData =
  { taskId: string } | { taskId: string; inputValue: unknown };

function isResumeJob(
  data: RunTaskJobData,
): data is Extract<RunTaskJobData, { inputValue: unknown }> {
  return 'inputValue' in data;
}

// How long a processing claim stays valid before another delivery may take
// it over. Deliberately far above any legitimate in-flight invocation: an
// operation's agent budget is capped at 300s (RQ.6) — enforced, not merely
// tabulated, by the clamp in AgentRegistry.getTimeoutS, which is what this
// number's safety actually rests on — and AgentInvocationService aborts its
// own HTTP call at that ceiling plus its margin, so nothing legitimate can
// still be running after this. A claim this old means the worker holding it
// died — killed mid-invocation, container restarted — without ever reaching
// the release below, and the Task would otherwise be unprocessable forever.
const CLAIM_LEASE_MS = 10 * 60 * 1000;

// The queue consumer (PoC's TaskProcessor, fig. 7/8). One job per Task,
// picked up independently — RF.48's "a failing job doesn't drag down the
// others" is BullMQ's normal per-job isolation, and it holds whether or not
// an error escapes process(): a job that throws is marked failed and the
// other jobs are untouched. Errors do escape here — claim() sits outside the
// try, the outer block is try/finally with no catch, and finishFailed writes
// to Mongo from inside the catch — and none of that costs RF.48 anything.
// The try/catch around the agent invocation earns its place for a different
// reason: it leaves the user a FAILED Report (see finishFailed).
//
// BE-17 adds the resume shape to this same Processor rather than a separate
// one: a resume is still "run this Task's next step", it just starts from
// RUNNING instead of PENDING and calls a different AgentInvocationService
// method — keeping both here means the COMPLETED/FAILED/INTERRUPTED
// handling and the batch-completed check only exist once. BE-18 hangs the
// Report assembly off that same single handling point.
//
// Every read-then-write in here is a conditional write (claim(),
// markRunning(), persistIfStillRunning()) rather than the mutate-then-
// save() this class used to do. Two different races made that necessary:
// a duplicate BullMQ delivery reading the same Task before the first
// delivery finished (both would invoke the agent), and a cancel landing
// mid-invocation only to be overwritten by the completing run (save()
// writes the paths touched in memory without looking at what the database
// says now). Both are gone if — and only if — the guard lives in the query
// filter, where the database can enforce it, instead of in an `if` over a
// value read moments earlier.
@Processor('tasks')
export class TaskProcessor extends WorkerHost {
  private readonly logger = new Logger(TaskProcessor.name);

  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    private readonly events: EventsGateway,
    private readonly agentInvocation: AgentInvocationService,
    private readonly agentRegistry: AgentRegistry,
    private readonly reportAssembly: ReportAssemblyService,
  ) {
    super();
  }

  async process(job: Job<RunTaskJobData>): Promise<void> {
    const claimed = await this.claim(job.data.taskId);
    if (!claimed) {
      // Gone, already claimed by a concurrent delivery, or in a terminal
      // state (a cancel that landed before the worker got here — CANCELLED,
      // COMPLETED and FAILED simply aren't in the claim filter). Nothing to
      // do or report on in any of those cases.
      return;
    }

    // The token is carried here rather than read back off `task` because
    // every write below has to be fenced by the claim *this* call took, not
    // by whatever the document happens to hold by the time the write runs.
    const { task, claimToken } = claimed;

    try {
      if (
        task.status === 'PENDING' &&
        !(await this.markRunning(task, claimToken))
      ) {
        // Cancelled in the window between the claim and the transition.
        return;
      }

      // BE-18: machine time for *this* call only, added to whatever earlier
      // segments already accumulated — never reset, since a paused-then-
      // resumed Task reaches here more than once. Wraps the SPRINT_ID
      // pre-check too (startOrPause can return INTERRUPTED without ever
      // calling the agent); that's still machine time, just a very small
      // amount of it.
      const startedAt = Date.now();
      try {
        const result = isResumeJob(job.data)
          ? await this.agentInvocation.resume(task, job.data.inputValue)
          : await this.startOrPause(task);
        task.accumulatedMs += Date.now() - startedAt;
        await this.applyResult(task, claimToken, result);
      } catch (err) {
        task.accumulatedMs += Date.now() - startedAt;
        await this.finishFailed(task, claimToken, {
          code: 'UPSTREAM',
          message: err instanceof Error ? err.message : 'Unknown error',
          stage: 'EXECUTION',
        });
      }

      await this.maybeEmitBatchCompleted(task.batchId, task.userId);
    } finally {
      // A safety net, not the primary release. The one outcome that hands
      // control back to the user — INTERRUPTED — releases the claim in the
      // same write that records the pause (see applyResult), so a failure
      // of this release can no longer cost anyone their answer: it can only
      // leave a claim behind on a Task nobody is waiting on, which the
      // lease takes over anyway. What still needs it is the exception path,
      // and the early return when a cancel wins the PENDING transition.
      await this.releaseClaim(task, claimToken);
    }
  }

  // Claiming and reading are one atomic operation on purpose: the filter is
  // what makes a second, concurrent delivery of the same job a no-op —
  // only one writer can move processingClaimedAt away from null-or-stale,
  // and the loser gets null back here and returns without touching the
  // agent. Reading first and checking afterwards cannot express that, which
  // is exactly how two deliveries used to both get past the RUNNING
  // fallthrough and invoke the agent twice.
  private async claim(
    taskId: string,
  ): Promise<{ task: TaskDocument; claimToken: string } | null> {
    // One clock read for both ends of the comparison: the threshold below
    // and the stamp written on success have to be the same "now", or a
    // claim could be judged stale against a moment it was never measured
    // from.
    const now = Date.now();
    const staleBefore = new Date(now - CLAIM_LEASE_MS);
    // Fresh per claim, including a takeover of a stale one — this is what
    // later writes prove ownership with.
    const claimToken = randomUUID();

    const task = await this.taskModel.findOneAndUpdate(
      {
        _id: taskId,
        // The three ways a Task may legitimately be picked up: a fresh
        // PENDING one, a Changelog continuation whose sprintId was just
        // answered, and a resume — the last two both already RUNNING.
        // Terminal statuses are absent by construction, which is also what
        // makes a cancelled Task skip silently.
        status: { $in: ['PENDING', 'RUNNING'] },
        $or: [
          { processingClaimedAt: null },
          { processingClaimedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          processingClaimedAt: new Date(now),
          processingClaimToken: claimToken,
        },
      },
      { new: true },
    );

    return task === null ? null : { task, claimToken };
  }

  // Releasing is conditioned on still holding the claim, not merely on the
  // Task's id. Without that condition the protection collapsed permanently
  // the first time any lease expired: A claims; A's lease expires; B takes
  // over and is the legitimate holder, still inside its invocation; A
  // finishes and its finally clears *B's* claim; C claims and invokes the
  // agent alongside B. Two concurrent invocations — the exact bug the claim
  // exists to prevent — and two assembleCompleted calls behind them, so two
  // Reports for one Task, both visible in GET /reports (which filters on
  // userId alone).
  //
  // Releasing a claim that is no longer ours is a silent no-op: the holder
  // that owns it now is mid-invocation and there is nothing here worth
  // reporting to anyone.
  private async releaseClaim(
    task: TaskDocument,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.taskModel.updateOne(
        { _id: task._id, processingClaimToken: claimToken },
        { $set: { processingClaimedAt: null, processingClaimToken: null } },
      );
    } catch (err) {
      // Never rethrow from the finally: the work itself may well have
      // succeeded, and failing the whole job over the release would undo
      // RF.48's isolation for no gain. A claim left behind here is taken
      // over again after CLAIM_LEASE_MS.
      this.logger.warn(
        `Could not release the processing claim on Task ${task.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // The PENDING → RUNNING transition, conditioned on the Task still being
  // PENDING rather than on the in-memory canTransitionTo() this used to
  // call. Same rule TRANSITIONS encodes (PENDING is the only status with
  // RUNNING as a legal next step), but expressed where it can actually be
  // enforced: as a filter, so a cancel landing between the claim and this
  // write wins instead of being overwritten by a $set computed from a read
  // taken moments earlier.
  //
  // Deliberately not mirrored onto the in-memory document. The caller keeps
  // using that document, and AgentInvocationService save()s it further down
  // to persist lgThreadId — a Mongoose save() flushes every path touched in
  // memory, so assigning status here would let that unrelated save write
  // RUNNING back over a cancel that landed in between, reintroducing the
  // very lost update the conditional writes in this class exist to prevent.
  private async markRunning(
    task: TaskDocument,
    claimToken: string,
  ): Promise<boolean> {
    const { matchedCount } = await this.taskModel.updateOne(
      { _id: task._id, status: 'PENDING', processingClaimToken: claimToken },
      { $set: { status: 'RUNNING' } },
    );
    if (matchedCount === 0) {
      return false;
    }

    this.events.emitTaskUpdated(task.userId, task.id, 'RUNNING');
    return true;
  }

  // Every state change a finished (or paused) invocation wants to make goes
  // through here: a $set conditioned on the Task still being RUNNING,
  // instead of task.save(). save() writes whatever paths were touched in
  // memory without looking at what the database holds now, so a cancel that
  // landed while the agent was working was silently overwritten by the
  // completing invocation.
  //
  // The claim is part of the filter for the same reason the status is: a
  // worker whose lease expired is no longer this Task's writer, and its
  // successor is already working. Without it, an expired holder could still
  // stamp a terminal status (and a Report id) over a run that is still
  // going — the release-side hole of the same shape, reached from the write
  // side instead.
  //
  // False therefore means someone else moved the Task — cancelled it, or
  // took the claim over — and this invocation's result must be neither
  // applied nor announced.
  //
  // The cost of that second meaning, which is real and was not written down
  // when the token went in: a worker whose lease expired used to be able to
  // stamp the terminal status anyway, and in doing so it closed out Tasks
  // whose successor then died. It cannot now. So a Task can end up RUNNING
  // with nobody left to finish it — A takes the claim, A's lease expires, B
  // takes over, A completes and is refused here, B is then killed and BullMQ
  // has already spent its one stalled redelivery. Nothing re-enqueues it, and
  // maybeEmitBatchCompleted counts a RUNNING Task as active, so batch.completed
  // never fires for the whole batch either.
  //
  // That is the right trade — the write this refuses is exactly the one that
  // produced two Reports for one Task — and it is not a dead end for the
  // user, because TasksService.markCancelled does not filter on the token, so
  // cancelling still works. It is a gap in coverage, not in correctness: what
  // is missing is a sweep for Tasks left RUNNING past any plausible lease,
  // which nothing in this codebase does yet.
  private async persistIfStillRunning(
    task: TaskDocument,
    claimToken: string,
    changes: Record<string, unknown>,
  ): Promise<boolean> {
    const { matchedCount } = await this.taskModel.updateOne(
      { _id: task._id, status: 'RUNNING', processingClaimToken: claimToken },
      { $set: changes },
    );
    return matchedCount === 1;
  }

  // BE-17: the Changelog agents need a Sprint ID that's never known at
  // context-creation time — collected interactively, the first time a
  // Changelog Task actually reaches the front of the queue, rather than
  // blocking POST /tasks itself on it. A plain {taskId} job reaches this
  // twice for the same Task when that happens: once to discover sprintId is
  // missing and pause, again after POST /tasks/:id/input has set it — the
  // second time the Task is already RUNNING, so process() skips the PENDING
  // transition and comes straight here, and this time the check falls
  // through to invoke().
  private async startOrPause(
    task: TaskDocument,
  ): Promise<AgentInvocationResult> {
    const needsSprintId =
      this.agentRegistry.getAgent(task.operation) === 'CHANGELOG' &&
      task.sprintId == null;

    if (needsSprintId) {
      return { status: 'INTERRUPTED', pendingInput: { kind: 'SPRINT_ID' } };
    }
    return this.agentInvocation.invoke(task);
  }

  private async applyResult(
    task: TaskDocument,
    claimToken: string,
    result: AgentInvocationResult,
  ): Promise<void> {
    if (result.status === 'INTERRUPTED') {
      // The claim is released *here*, inside the same conditional write
      // that records the pause, rather than in process()'s finally. The
      // pause and the release are one fact: the moment this Task is waiting
      // on a human it is no longer being worked on, and the invocation that
      // produced this result has already returned, so there is nothing left
      // for the claim to protect.
      //
      // Doing it in the finally instead left a window between
      // emitTaskInputRequired() below — the very event whose purpose is to
      // make the frontend answer — and the release. An answer landing in
      // that window enqueued a job whose claim() found the claim still held
      // and returned null, so the job exited silently; with no `attempts`
      // configured on the queue (tasks.module.ts) BullMQ counts that as a
      // success and never retries, stranding the Task RUNNING with
      // pendingInput already cleared and no way for the user to answer
      // again. Releasing before the emit would only shrink the window;
      // folding the release into the write removes it, because the pause is
      // not observable by anyone until the claim is already gone.
      const persisted = await this.persistIfStillRunning(task, claimToken, {
        pendingInput: result.pendingInput,
        accumulatedMs: task.accumulatedMs,
        processingClaimedAt: null,
        processingClaimToken: null,
      });
      if (!persisted) {
        return;
      }
      task.pendingInput = result.pendingInput;
      this.events.emitTaskInputRequired(
        task.userId,
        task.id,
        result.pendingInput,
      );
      return;
    }

    if (result.status === 'FAILED') {
      // The type says `error` is always populated (AgentInvocationService's
      // own failure() always builds one) — this fallback is for whatever a
      // caller passes at runtime regardless of what the type promises.
      const error = result.error ?? {
        code: 'UPSTREAM',
        message: 'Agent invocation failed with no further detail',
        stage: 'EXECUTION',
      };
      await this.finishFailed(task, claimToken, error);
      return;
    }

    await this.finishCompleted(task, claimToken, result.payload);
  }

  // BE-18: assembles and persists the Report, then lets the frontend reach
  // it the same way it already reaches everything else about a Task — via
  // TaskDto.reportId (GET /tasks/:id) and the reportId this same event
  // carries.
  private async finishCompleted(
    task: TaskDocument,
    claimToken: string,
    payload: AgentRunPayload,
  ): Promise<void> {
    const report = await this.reportAssembly.assembleCompleted(task, payload);
    const persisted = await this.persistIfStillRunning(task, claimToken, {
      status: 'COMPLETED',
      reportId: report._id,
      accumulatedMs: task.accumulatedMs,
    });
    if (!persisted) {
      // A cancel landed while the agent was still working (or this worker
      // lost its claim). The Task keeps whatever it holds now — no status
      // flip back to COMPLETED, and no task.updated contradicting the
      // task.updated CANCELLED the frontend already got.
      //
      // The Report assembled two lines up has to go with it. It is not an
      // unreferenced row: the pointer runs Report -> Task (Report.taskId,
      // required), not Task -> Report, and GET /reports filters on userId
      // alone — so leaving it there puts a COMPLETED report of this very
      // execution in the user's list next to the CANCELLED Task it belongs
      // to, openable through GET /reports/:id and exportable to PDF through
      // BE-20. Only Task.reportId stays null. That is a visible
      // contradiction, not a stray row.
      await this.discardOrphanReport(report);
      return;
    }

    task.reportId = report._id;
    task.status = 'COMPLETED';
    this.events.emitTaskUpdated(
      task.userId,
      task.id,
      'COMPLETED',
      task.reportId.toString(),
    );
  }

  // Shared by applyResult's FAILED branch and process()'s catch block — a
  // Task that never reaches the agent at all (e.g. resume() throwing on a
  // missing lgThreadId) still needs a Report to point users at, same as one
  // the agent itself reported failing: "con successo o meno" (BE-18) covers
  // both.
  private async finishFailed(
    task: TaskDocument,
    claimToken: string,
    error: TaskError,
  ): Promise<void> {
    const report = await this.reportAssembly.assembleFailed(task, error);
    const persisted = await this.persistIfStillRunning(task, claimToken, {
      status: 'FAILED',
      error,
      reportId: report._id,
      accumulatedMs: task.accumulatedMs,
    });
    if (!persisted) {
      // Same reasoning as finishCompleted: someone got here first and this
      // failure is no longer the Task's outcome to announce — nor its
      // Report to leave behind. A FAILED Report is just as visible in GET
      // /reports as a COMPLETED one.
      await this.discardOrphanReport(report);
      return;
    }

    task.reportId = report._id;
    task.status = 'FAILED';
    task.error = error;
    this.events.emitTaskFailed(task.userId, task.id, error);
  }

  // Deleting the Report must not fail the job — same reasoning as
  // releaseClaim, and RF.48's per-job isolation. The work either was or
  // wasn't announced to the user by the time we get here, and that outcome
  // is already settled; a delete that fails leaves exactly the inconsistency
  // this method exists to remove, which is worth a log and not worth
  // discarding a job over.
  private async discardOrphanReport(report: ReportDocument): Promise<void> {
    try {
      await this.reportAssembly.discard(report);
    } catch (err) {
      this.logger.warn(
        `Could not delete the orphaned Report ${String(report._id)} left by a Task that moved on: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Whether every Task in this batch has reached a terminal state — checked
  // by querying rather than a maintained counter, since a batch is a small,
  // short-lived group and there's no separate Batch collection to keep a
  // counter on (batchId is a correlation label only, per Task's own schema
  // comment). A RUNNING Task paused on pendingInput still counts as active
  // here exactly as it did before BE-17 — this query was never
  // status-specific beyond PENDING/RUNNING — so a batch with a paused Task
  // correctly never reports completed until it's answered one way or
  // another.
  private async maybeEmitBatchCompleted(
    batchId: string,
    userId: string,
  ): Promise<void> {
    const stillActive = await this.taskModel.countDocuments({
      batchId,
      status: { $in: ['PENDING', 'RUNNING'] },
    });
    if (stillActive > 0) {
      return;
    }

    const [completed, failed] = await Promise.all([
      this.taskModel.countDocuments({ batchId, status: 'COMPLETED' }),
      this.taskModel.countDocuments({
        batchId,
        status: { $in: ['FAILED', 'CANCELLED'] },
      }),
    ]);
    this.events.emitBatchCompleted(userId, batchId, completed, failed);
  }
}

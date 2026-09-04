import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { OperationCode } from '../../common/domain-types';
import type { PendingInput, TaskError, TaskStatus } from '../task.types';

// Mongoose only wires up methods attached via `schema.methods` — a method
// written inside this class body would type-check fine but never actually
// run on a real document. TaskMethods + the second HydratedDocument type
// parameter is how TypeScript is told about a method that lives there
// instead, without a dead copy sitting in the class for someone to edit by
// mistake.
export interface TaskMethods {
  canTransitionTo(newStatus: TaskStatus): boolean;
}

export type TaskDocument = HydratedDocument<Task, TaskMethods>;

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

@Schema({ timestamps: true })
export class Task {
  @Prop({ required: true })
  userId: string;

  // Shared by every Task created from the same POST /tasks call — a
  // correlation label, not a reference to any other collection.
  @Prop({ required: true })
  batchId: string;

  @Prop({ type: Types.ObjectId, ref: 'AnalysisContext', required: true })
  contextId: Types.ObjectId;

  @Prop({ type: String, required: true })
  operation: OperationCode;

  @Prop({ type: String, required: true, default: 'PENDING' })
  status: TaskStatus;

  @Prop({ default: 0 })
  progressPercent: number;

  @Prop({ type: String, default: null })
  currentStage: string | null;

  // Valorized when status is COMPLETED *or* FAILED — a failed Task still
  // has a report to open (empty body, error populated).
  @Prop({ type: Types.ObjectId, ref: 'Report', default: null })
  reportId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  error: TaskError | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  pendingInput: PendingInput;

  // Only used by the Changelog operations; collected interactively during
  // execution, not at context creation.
  @Prop()
  sprintId?: string;

  // Set when this Task is a "Riprova" of a failed one — a retry is a new
  // Task, never a reopening of the old one.
  @Prop({ type: Types.ObjectId, ref: 'Task' })
  previousTaskId?: Types.ObjectId;

  // LangGraph thread id, generated once per Task at first invocation
  // (BE-15). Maps a Task to its checkpointed execution on the agent side.
  @Prop()
  lgThreadId?: string;

  // BE-1 anticipated this field for "issues successive" but never added it;
  // BE-18 is that issue. Machine time only, summed across every
  // invoke()/resume() call TaskProcessor makes for this Task — accumulated
  // rather than a single start/end pair because a paused-then-resumed Task
  // (BE-17) has one or more gaps (queue wait, pendingInput wait) that must
  // never count, and each resume is a separate process() call with no
  // in-memory state surviving between them. Read once, at Report assembly
  // time, as the finished value of executionTimeMs (§11.7's field is named
  // durationMs on Report — see that schema's own comment).
  @Prop({ default: 0 })
  accumulatedMs: number;

  // Processing lease. BullMQ delivers at-least-once, so the same job can be
  // handed to two workers at once (a worker restart, an expired lock,
  // several backend replicas) — this is what makes the second delivery a
  // no-op instead of a second agent invocation. Null (or absent, for Tasks
  // written before this field existed) means "free to process"; a timestamp
  // means a worker holds it. TaskProcessor claims it atomically before
  // touching the agent and releases it as part of whichever write settles
  // the Task's outcome (with a finally block as the safety net for the
  // exception path); a claim older than its lease window is taken over, so
  // a worker killed mid-invocation doesn't strand the Task forever.
  @Prop({ type: Date, default: null })
  processingClaimedAt: Date | null;

  // Fencing token: who holds the claim above, not just that someone does.
  // Regenerated on every successful claim, and required to match before a
  // holder may release the claim or write the Task's outcome, so a worker
  // whose lease expired cannot act on a Task its successor has taken over.
  //
  // A separate value rather than reusing processingClaimedAt as the token:
  // two claims can carry the same timestamp (millisecond resolution, or a
  // clock stepped backwards by NTP), and a token that can collide is not a
  // token. Null exactly when processingClaimedAt is null.
  @Prop({ type: String, default: null })
  processingClaimToken: string | null;
}

export const TaskSchema = SchemaFactory.createForClass(Task);

// BE-1 asked for "schemi e indici" and this schema declared none, so every
// query below was a collection scan.
//
// TaskProcessor.maybeEmitBatchCompleted issues three countDocuments filtering
// on batchId (+ status) at the end of *every* job — a batch of seven
// operations pays for that twenty-one times, and it runs inside the window
// between announcing a pause and the user answering it, where a slow query is
// not merely wasted work.
TaskSchema.index({ batchId: 1, status: 1 });

// TasksService.findAllForUser: filter on userId, sort on createdAt — the
// dashboard's list query, and the same (owner, recency) shape Report already
// indexes for its own history query. Sorted descending in the index so the
// sort is served by it rather than done in memory.
TaskSchema.index({ userId: 1, createdAt: -1 });

// The only place this logic actually lives — see the TaskMethods comment
// above for why it isn't declared inside the Task class instead.
TaskSchema.methods.canTransitionTo = function (
  this: Task,
  newStatus: TaskStatus,
): boolean {
  return TRANSITIONS[this.status]?.includes(newStatus) ?? false;
};

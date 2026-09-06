import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import type { OperationCode } from "../../common/domain-types";
import type { PendingInput, TaskError, TaskStatus } from "../task.types";

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
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

@Schema({ timestamps: true })
export class Task {
  @Prop({ required: true })
  userId!: string;

  // Shared by every Task created from the same POST /tasks call — a
  // correlation label, not a reference to any other collection.
  @Prop({ required: true })
  batchId!: string;

  @Prop({ type: Types.ObjectId, ref: "AnalysisContext", required: true })
  contextId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  operation!: OperationCode;

  @Prop({ type: String, required: true, default: "PENDING" })
  status!: TaskStatus;

  @Prop({ default: 0 })
  progressPercent!: number;

  @Prop({ type: String, default: null })
  currentStage!: string | null;

  // Valorized when status is COMPLETED *or* FAILED — a failed Task still
  // has a report to open (empty body, error populated).
  @Prop({ type: Types.ObjectId, ref: "Report", default: null })
  reportId!: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  error!: TaskError | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  pendingInput!: PendingInput;

  // Only used by the Changelog operations; collected interactively during
  // execution, not at context creation.
  @Prop()
  sprintId?: string;

  // Set when this Task is a "Riprova" of a failed one — a retry is a new
  // Task, never a reopening of the old one.
  @Prop({ type: Types.ObjectId, ref: "Task" })
  previousTaskId?: Types.ObjectId;

  // LangGraph thread id, generated once per Task at first invocation
  // (BE-15). Maps a Task to its checkpointed execution on the agent side.
  @Prop()
  lgThreadId?: string;
}

export const TaskSchema = SchemaFactory.createForClass(Task);

// The only place this logic actually lives — see the TaskMethods comment
// above for why it isn't declared inside the Task class instead.
TaskSchema.methods.canTransitionTo = function (this: Task, newStatus: TaskStatus): boolean {
  return TRANSITIONS[this.status]?.includes(newStatus) ?? false;
};

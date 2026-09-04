import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { OperationCode } from '../../common/domain-types';
import type {
  Block,
  Proposal,
  ReportContext,
  ReportError,
  ReportStatus,
} from '../report.types';

export type ReportDocument = HydratedDocument<Report>;

@Schema({ timestamps: { createdAt: 'generatedAt', updatedAt: false } })
export class Report {
  @Prop({ type: Types.ObjectId, ref: 'Task', required: true })
  taskId: Types.ObjectId;

  // Denormalized, not exposed in ReportDto — needed for the ownership check
  // and the (userId, generatedAt) index; resolving it through Task at read
  // time would defeat the point of a single indexed query (§12.7).
  @Prop({ required: true })
  userId: string;

  @Prop({ type: String, required: true })
  operation: OperationCode;

  @Prop({ type: String, required: true })
  status: ReportStatus;

  // Composed deterministically by the backend, never by the model — always
  // present, even on a FAILED report.
  @Prop({ required: true })
  title: string;

  @Prop({ type: String, default: null })
  summary: string | null;

  // Machine time only; null when no agent was ever invoked. Whether the
  // agent or the backend writes this is an open point (§11.7) — the field
  // exists either way.
  @Prop({ type: Number, default: null })
  durationMs: number | null;

  // Persisted, never exposed via the API — flows through from the agent's
  // own state, kept because the PoC already carries it (fig. 3), not
  // because anything currently reads it.
  @Prop()
  tokensConsumed: number;

  // Copied from AnalysisContext at assembly time — a report is an immutable
  // record and must stay complete even if the context is later removed.
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  context: ReportContext;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  body: Block[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  proposal?: Proposal;

  @Prop({ type: MongooseSchema.Types.Mixed })
  error?: ReportError;

  // Injected by the `timestamps: { createdAt: 'generatedAt' }` option above
  // at the schema level, not by a @Prop() — declaring it again here would
  // register the same path twice. This plain field exists only so
  // TypeScript (ReportDocument = HydratedDocument<Report>) knows it's
  // there; BE-19 is the first code that actually reads it.
  generatedAt: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);
ReportSchema.index({ userId: 1, generatedAt: -1 });

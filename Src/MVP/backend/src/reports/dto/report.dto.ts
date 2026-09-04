import type { OperationCode } from '../../common/domain-types';
import type { ReportDocument } from '../schemas/report.schema';
import type {
  Block,
  Proposal,
  ReportContext,
  ReportError,
  ReportStatus,
} from '../report.types';
import type { PendingInput } from '../../tasks/task.types';

// What GET /reports/:id returns — the full Report, minus userId (schema's
// own comment: denormalized for the ownership check/index, never exposed),
// plus pendingAction (see below).
export interface ReportDto {
  id: string;
  taskId: string;
  operation: OperationCode;
  status: ReportStatus;
  title: string;
  summary: string | null;
  durationMs: number | null;
  tokensConsumed: number;
  generatedAt: string;
  context: ReportContext;
  body: Block[];
  proposal?: Proposal;
  error?: ReportError;
  // BE-19: read-only projection of the owning Task's current pendingInput —
  // named differently on purpose, same as Report.error already diverges
  // from Task.error's field name (`kind` vs `code`) rather than forcing a
  // shared vocabulary across two different documents.
  //
  // In practice this is close to always null: a Report only exists once its
  // Task reaches a terminal state (COMPLETED/FAILED — see BE-18), and a
  // terminal Task's pendingInput is always already cleared by then. The one
  // case where it wouldn't be is BUSINESS_CONFIRMATION's technicalReportId
  // (BE-17), which names a Report that's supposed to exist for a *draft*,
  // before its Task actually finishes — but neither BE-17 nor BE-18 as
  // implemented have a path that persists an intermediate Report on a
  // still-RUNNING Task, so that case can't surface a non-null pendingAction
  // today either way. Flagged here rather than routed around.
  pendingAction: PendingInput;
}

export function toReportDto(
  report: ReportDocument,
  pendingAction: PendingInput,
): ReportDto {
  return {
    id: report.id,
    taskId: report.taskId.toString(),
    operation: report.operation,
    status: report.status,
    title: report.title,
    summary: report.summary,
    durationMs: report.durationMs,
    tokensConsumed: report.tokensConsumed,
    generatedAt: report.generatedAt.toISOString(),
    context: report.context,
    body: report.body,
    proposal: report.proposal,
    error: report.error,
    pendingAction,
  };
}

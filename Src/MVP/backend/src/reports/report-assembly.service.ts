import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Report, ReportDocument } from './schemas/report.schema';
import {
  AnalysisContext,
  AnalysisContextDocument,
} from '../contexts/schemas/analysis-context.schema';
import { AgentRegistry } from '../operations/agent-registry.service';
import { AgentRunPayload } from '../tasks/agent-client.types';
import { TaskDocument } from '../tasks/schemas/task.schema';
import { TaskError } from '../tasks/task.types';
import { Proposal, ReportContext } from './report.types';
import {
  isSafeDestination,
  sanitizeMarkdown,
  sanitizeReportBody,
} from './markdown-sanitizer';

// BE-18: builds the persisted Report once a Task reaches a terminal state
// (COMPLETED or FAILED — never CANCELLED, which never ran an agent and has
// nothing to report on). Two entry points rather than one method with a
// status flag: COMPLETED and FAILED build genuinely different shapes (a
// payload to fold in vs. an error to record, a title either way), and
// TaskProcessor already knows which one it has before calling in.
@Injectable()
export class ReportAssemblyService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(AnalysisContext.name)
    private readonly contextModel: Model<AnalysisContextDocument>,
    private readonly agentRegistry: AgentRegistry,
  ) {}

  async assembleCompleted(
    task: TaskDocument,
    payload: AgentRunPayload,
  ): Promise<ReportDocument> {
    const context = await this.loadContext(task);
    return this.reportModel.create({
      taskId: task._id,
      userId: task.userId,
      operation: task.operation,
      status: 'COMPLETED',
      title: this.buildTitle(task, context),
      // BE-18 sanitizes at the boundary, and summary crosses it from the
      // agent exactly like body does — it was the one free-form field the
      // agent writes that went into the Report, and out through ReportDto,
      // without passing anything.
      summary:
        payload.summary == null ? null : sanitizeMarkdown(payload.summary),
      // Machine time only — task.accumulatedMs never includes queue wait,
      // pendingInput wait, or PDF generation (BE-20 runs after this, on an
      // already-persisted Report). See Task schema's own comment.
      durationMs: task.accumulatedMs,
      tokensConsumed: payload.tokensConsumed,
      context: this.denormalizeContext(context),
      body: sanitizeReportBody(payload.body),
      proposal: sanitizeProposal(payload.proposal),
    });
  }

  async assembleFailed(
    task: TaskDocument,
    error: TaskError,
  ): Promise<ReportDocument> {
    const context = await this.loadContext(task);
    return this.reportModel.create({
      taskId: task._id,
      userId: task.userId,
      operation: task.operation,
      status: 'FAILED',
      title: this.buildTitle(task, context),
      summary: null,
      durationMs: null,
      context: this.denormalizeContext(context),
      body: [],
      error: { kind: error.code, message: error.message, stage: error.stage },
    });
  }

  // Undoes an assemble*() whose Task turned out to have moved on — a cancel
  // that landed while the agent was working, or a claim taken over by
  // another worker. Deletes by _id and nothing else: a Task legitimately
  // re-run has several historical Reports, and a query by taskId would take
  // them with it.
  //
  // Delete rather than a CANCELLED status, because ReportStatus is
  // 'COMPLETED' | 'FAILED' (report.types.ts) and a third value propagates
  // into ReportDto, ReportSummaryDto, the `status === 'FAILED'` check in
  // reports-export.service, and the PDF composer. Removing a row that the
  // caller created moments earlier and that no other document references has
  // no type surface at all.
  async discard(report: ReportDocument): Promise<void> {
    await this.reportModel.deleteOne({ _id: report._id });
  }

  private async loadContext(
    task: TaskDocument,
  ): Promise<AnalysisContextDocument> {
    const context = await this.contextModel.findById(task.contextId);
    if (!context) {
      // The context is only ever deleted after every Report referencing it
      // has already denormalized what it needs (RF — a Report must outlive
      // its context) — a missing context *during* assembly means the Task
      // itself is in an inconsistent state, not a condition to paper over.
      throw new Error(
        `AnalysisContext ${task.contextId.toString()} not found while assembling Report for Task ${task.id}`,
      );
    }
    return context;
  }

  // Deterministic, from data the backend already has — never composed by
  // the model, and identical whether the Task succeeded or failed, so a
  // FAILED Report is just as findable in a list as a COMPLETED one.
  private buildTitle(
    task: TaskDocument,
    context: AnalysisContextDocument,
  ): string {
    const displayName = this.agentRegistry.getDisplayName(task.operation);
    return `${displayName} — ${context.repoOwner}/${context.repoName}@${context.branch}`;
  }

  private denormalizeContext(context: AnalysisContextDocument): ReportContext {
    return {
      repoOwner: context.repoOwner,
      repoName: context.repoName,
      repoUrl: context.repoUrl,
      branch: context.branch,
      resolvedSha: context.resolvedSha,
      scopeType: context.scopeType,
      paths: context.paths,
    };
  }
}

// diffUnified is deliberately left alone: it is a unified diff, not Markdown,
// and rewriting it would corrupt the patch it exists to carry (BE-9 applies
// it verbatim). targetPath and language are structured values, never prose.
// pullRequestUrl is the one field here a frontend will render as a link, so
// it answers to the same allowlist every Markdown destination does — an
// agent that reports a `javascript:` URL gets no link, not a live one.
function sanitizeProposal(proposal?: Proposal): Proposal | undefined {
  if (!proposal) {
    return undefined;
  }

  const { pullRequestUrl } = proposal;
  return {
    ...proposal,
    pullRequestUrl:
      pullRequestUrl !== null && isSafeDestination(pullRequestUrl)
        ? pullRequestUrl
        : null,
  };
}

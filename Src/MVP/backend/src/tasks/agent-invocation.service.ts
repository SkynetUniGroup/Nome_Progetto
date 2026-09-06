import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PendingInput, TaskError, TaskStatus } from './task.types';
import { TaskDocument } from './schemas/task.schema';
import { AgentRegistry } from '../operations/agent-registry.service';
import {
  AgentResumeRequest,
  AgentRunPayload,
  AgentStartRequest,
  AgentStepResult,
} from './agent-client.types';
import { mapAgentErrorKind } from './agent-error-mapping';
import { TemplatesService } from '../templates/templates.service';

// A third outcome alongside the Task-terminal COMPLETED/FAILED: the agent
// paused mid-run (or, for Changelog, was never started at all — see
// TaskProcessor.startOrPause) and needs a human answer before it can
// continue. Task itself stays RUNNING for this (BE-13's five states are
// unchanged); INTERRUPTED only exists here, as the signal TaskProcessor
// uses to set pendingInput instead of a terminal status.
export type AgentInvocationResult =
  | { status: Extract<TaskStatus, 'COMPLETED'>; payload: AgentRunPayload }
  | { status: Extract<TaskStatus, 'FAILED'>; error: TaskError }
  | { status: 'INTERRUPTED'; pendingInput: Exclude<PendingInput, null> };

// HTTP margin added on top of the agent's own timeout budget (Tabella 45),
// so the gateway never times out before the agent itself would.
const HTTP_TIMEOUT_MARGIN_S = 5;

@Injectable()
export class AgentInvocationService {
  constructor(
    private readonly config: ConfigService,
    private readonly agentRegistry: AgentRegistry,
    private readonly templates: TemplatesService,
  ) {}

  async invoke(task: TaskDocument): Promise<AgentInvocationResult> {
    const threadId = task.lgThreadId ?? randomUUID();
    if (!task.lgThreadId) {
      task.lgThreadId = threadId;
      await task.save();
    }

    const body: AgentStartRequest = {
      taskId: task.id,
      threadId,
      operationCode: task.operation,
      payload: await this.startPayload(task),
    };

    return this.call(task, '/internal/agent/start', body);
  }

  // RF.79: il template personalizzato dell'utente viaggia nel payload di
  // avvio, che fino a qui era sempre vuoto. Interrogato solo per
  // DOCS_README — è l'unica operazione che ne fa qualcosa, e le altre non
  // devono pagare una lettura in più a ogni avvio. Senza template il campo
  // resta assente e l'agente ricade sul proprio modello di default, che è
  // esattamente il ripristino descritto da RF.81.
  private async startPayload(task: TaskDocument): Promise<object> {
    if (task.operation !== 'DOCS_README') {
      return {};
    }

    const readmeTemplate = await this.templates.contentForUser(task.userId);
    return readmeTemplate ? { readmeTemplate } : {};
  }

  // BE-17: called after POST /tasks/:id/input clears an INCOMPLETE_TASKS or
  // BUSINESS_CONFIRMATION pendingInput — both only ever happen once the
  // agent has already produced a threadId via a prior invoke(). A missing
  // lgThreadId here means TaskProcessor routed a resume-task job at a Task
  // that was never actually started, which is a caller bug (see
  // TaskProcessor's job-shape comment), not a runtime condition worth
  // degrading gracefully from.
  async resume(
    task: TaskDocument,
    inputValue: unknown,
  ): Promise<AgentInvocationResult> {
    if (!task.lgThreadId) {
      throw new Error(
        `Task ${task.id} has no lgThreadId — cannot resume an agent run that never started`,
      );
    }

    const body: AgentResumeRequest = {
      taskId: task.id,
      threadId: task.lgThreadId,
      operationCode: task.operation,
      inputValue,
    };

    return this.call(task, '/internal/agent/resume', body);
  }

  private async call(
    task: TaskDocument,
    path: string,
    body: AgentStartRequest | AgentResumeRequest,
  ): Promise<AgentInvocationResult> {
    const timeoutMs =
      (this.agentRegistry.getTimeoutS(task.operation) + HTTP_TIMEOUT_MARGIN_S) *
      1000;
    const baseUrl = this.config.get<string>('AGENTS_SERVICE_URL');

    let result: AgentStepResult;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return this.failure(
          'UPSTREAM',
          `Agent service responded ${res.status}`,
        );
      }
      result = (await res.json()) as AgentStepResult;
    } catch (err) {
      // The agent didn't respond at all within our budget — we don't know
      // why, so this is UPSTREAM, not TIMEOUT. TIMEOUT is reserved for the
      // agent itself reporting that its own model call timed out (handled
      // below via mapAgentErrorKind).
      if (err instanceof Error && err.name === 'TimeoutError') {
        return this.failure('UPSTREAM', 'Agent invocation timed out');
      }
      return this.failure(
        'UPSTREAM',
        err instanceof Error ? err.message : 'Agent invocation failed',
      );
    }

    return this.toResult(result);
  }

  private toResult(result: AgentStepResult): AgentInvocationResult {
    if (result.status === 'completed') {
      if (!result.result) {
        // Same reasoning as the interrupted-without-pendingInput case below:
        // BE-18 needs a payload to build a Report from, so a 'completed'
        // response with nothing in it can't actually complete the Task.
        return this.failure(
          'PARSING',
          'Agent reported completed without a result payload',
        );
      }
      return { status: 'COMPLETED', payload: result.result };
    }

    if (result.status === 'interrupted') {
      if (!result.pendingInput) {
        // The agent said it paused but didn't say what it's waiting for —
        // can't route this to the right modal on the frontend, and leaving
        // the Task RUNNING with pendingInput still null would be
        // indistinguishable from "not paused" to every other code path that
        // checks that field. Treated as a failure instead.
        return this.failure(
          'PARSING',
          'Agent reported interrupted without a pendingInput',
        );
      }
      return { status: 'INTERRUPTED', pendingInput: result.pendingInput };
    }

    return this.failure(
      mapAgentErrorKind(result.error),
      result.error ?? 'Agent execution failed',
    );
  }

  private failure(
    code: TaskError['code'],
    message: string,
  ): AgentInvocationResult {
    return { status: 'FAILED', error: { code, message, stage: 'EXECUTION' } };
  }
}

import type { OperationCode } from '../common/domain-types';
import type { PendingInput } from './task.types';
import type { Block, Proposal } from '../reports/report.types';

// POST /internal/agent/start body.
export interface AgentStartRequest {
  taskId: string;
  threadId: string;
  operationCode: OperationCode;
  payload: object;
}

// What a 'completed' AgentStepResult carries in `result` — everything about
// the run that only the agent knows (BE-18 adds the rest: context, title,
// status, timing, error). Docs fills mostly `proposal`; Security fills
// `body` with FindingBlock/PolicyViolationBlock; Changelog fills `body`
// with TextBlock/ChangelogItemBlock — see report.types.ts's Block union.
export interface AgentRunPayload {
  body: Block[];
  proposal?: Proposal;
  summary?: string;
  tokensConsumed?: number;
}

// Response shape shared by /start and /resume.
export interface AgentStepResult {
  status: 'interrupted' | 'completed' | 'failed';
  pendingInput?: PendingInput;
  result?: AgentRunPayload;
  error?: string;
}

// POST /internal/agent/resume body. Mirrors AgentStartRequest's three
// identity fields (taskId, threadId, operationCode) rather than the bare
// {threadId, inputValue} pair from the agents/backend design doc (§49.1,
// listing 27): the agent service is stateless between HTTP calls, so
// threadId alone isn't enough for it to route back to get_agent_components
// and rebuild the GitHubToolset for that operation/context — it needs the
// same fields /start already sends, not just the LangGraph checkpoint id.
export interface AgentResumeRequest {
  taskId: string;
  threadId: string;
  operationCode: OperationCode;
  inputValue: unknown;
}

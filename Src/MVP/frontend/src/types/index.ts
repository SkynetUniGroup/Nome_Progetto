/**
 * Domain type definitions for the Code Guardian frontend.
 * Derived from Progettazione.pdf v1.0 – keep in sync with backend DTOs.
 */

// ---------------------------------------------------------------------------
// Auth / Users
// ---------------------------------------------------------------------------

/** Roles available in the system. Determines which operations a user may run. */
export type UserRole = 'DEVELOPER' | 'SECURITY_AUDITOR' | 'PROJECT_MANAGER';

/** Authenticated user payload stored in sessionStore (subset of JWT claims). */
export interface AuthUser {
  id: string;
  firstName: string;
  role: UserRole;
}

/** DTO sent to POST /auth/register */
export interface RegisterDto {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  role: UserRole;
}

/** DTO sent to POST /auth/login */
export interface LoginDto {
  email: string;
  password: string;
}

/**
 * Response from POST /auth/login.
 * The backend issues the token on its own; the profile is read separately
 * from GET /auth/me.
 */
export interface AuthTokenDto {
  accessToken: string;
}

/**
 * Response from POST /auth/register and GET /auth/me.
 * Registration does not issue a token — the caller logs in afterwards.
 */
export interface UserProfileDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
}

/** DTO sent to POST /credentials. */
export interface CreateCredentialDto {
  provider: 'GITHUB';
  token: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Current state of the user's stored credential for GitHub. */
export type CredentialsStatus = 'unknown' | 'missing' | 'connected' | 'invalid';

/**
 * A service credential record returned by GET /credentials.
 * Progettazione §20.4 – ServiceCredentialDto.
 *
 * There is no status field: the backend verifies the token against GitHub
 * before persisting it, so a stored credential is by construction one that
 * worked at `connectedAt`.
 */
export interface ServiceCredentialDto {
  id: string;
  /** The external service this credential authenticates against. */
  provider: 'GITHUB';
  /** ISO-8601 timestamp of the last successful verification. */
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** All operation codes supported by the platform. */
export type OperationCode =
  | 'DOCS_README'
  | 'DOCS_INLINE'
  | 'DOCS_API'
  | 'SECURITY_OWASP'
  | 'SECURITY_POLICY'
  | 'CHANGELOG_TECHNICAL'
  | 'CHANGELOG_BUSINESS';

/**
 * Maps each role to the operations it is permitted to launch.
 * Source: Progettazione.pdf Table 10.
 */
export const ROLE_OPERATIONS: Record<UserRole, OperationCode[]> = {
  DEVELOPER: ['DOCS_README', 'DOCS_INLINE', 'DOCS_API', 'CHANGELOG_TECHNICAL'],
  SECURITY_AUDITOR: ['SECURITY_OWASP', 'SECURITY_POLICY'],
  PROJECT_MANAGER: ['CHANGELOG_TECHNICAL', 'CHANGELOG_BUSINESS'],
};

/** Human-readable label for each operation code. */
export const OPERATION_LABELS: Record<OperationCode, string> = {
  DOCS_README: 'Documentazione README',
  DOCS_INLINE: 'Documentazione Inline',
  DOCS_API: 'Documentazione API',
  SECURITY_OWASP: 'Analisi Sicurezza OWASP',
  SECURITY_POLICY: 'Verifica Policy',
  CHANGELOG_TECHNICAL: 'Changelog Tecnico',
  CHANGELOG_BUSINESS: 'Changelog Business',
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Lifecycle status of a task. */
export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * Pending interactive input required from the user during task execution.
 * The Changelog agent may pause execution and wait for user decisions.
 * Note: pendingInput is a suspended sub-state within RUNNING, not a 6th status.
 */
export type PendingInput =
  | { kind: 'SPRINT_ID' }
  | { kind: 'INCOMPLETE_TASKS'; taskIds: string[] }
  | { kind: 'BUSINESS_CONFIRMATION'; technicalReportId: string };

/**
 * A single task entry as tracked in the frontend store.
 * Combines backend task data with real-time progress from WebSocket events.
 */
export interface TaskEntry {
  id: string;
  operation: OperationCode;
  status: TaskStatus;
  progressPercent: number;
  currentStage: string | null;
  reportId: string | null;
  error: { code: string; message: string; stage: string } | null;
  pendingInput: PendingInput | null;
}

/**
 * DTO sent to POST /tasks to launch a batch of operations.
 * Progettazione §20.4 – CreateTaskBatchDto.
 * Multiple operations can be submitted against the same context in a single request.
 */
export interface CreateTaskBatchDto {
  contextId: string;
  operations: OperationCode[];
}

/**
 * DTO sent to POST /tasks/:id/input to respond to a pending input request.
 * The shape changes based on the kind of input required.
 */
export type SubmitInputDto =
  | { kind: 'SPRINT_ID'; sprintId: string }
  | { kind: 'INCOMPLETE_TASKS'; action: 'PROCEED' | 'CANCEL' }
  | { kind: 'BUSINESS_CONFIRMATION'; action: 'PROCEED' | 'CANCEL' };

// ---------------------------------------------------------------------------
// WebSocket events
// ---------------------------------------------------------------------------

/** Fired when a task's top-level status changes (PENDING → RUNNING, etc.). */
export interface TaskUpdatedEvent {
  taskId: string;
  status: TaskStatus;
  reportId?: string;
}

/** Fired periodically during execution with stage-level progress. */
export interface TaskProgressEvent {
  taskId: string;
  stage: string;
  percent: number;
}

/** Fired when a task terminates with an error. */
export interface TaskFailedEvent {
  taskId: string;
  error: { code: string; message: string; stage: string };
}

/** Fired when all tasks in a batch complete. */
export interface BatchCompletedEvent {
  batchId: string;
  completed: string[];
  failed: string[];
}

/** Fired when the agent pauses and requires interactive input from the user. */
export interface TaskInputRequiredEvent {
  taskId: string;
  kind: 'SPRINT_ID' | 'INCOMPLETE_TASKS' | 'BUSINESS_CONFIRMATION';
  taskIds?: string[];
  reportId?: string;
}

// ---------------------------------------------------------------------------
// Repositories & Context
// ---------------------------------------------------------------------------

/** A GitHub repository returned by GET /repositories. */
export interface Repository {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * DTO sent to POST /contexts to save an analysis context.
 * Progettazione §20.4 – CreateContextDto.
 */
export interface CreateContextDto {
  /** Full GitHub URL of the repository; the backend validates its shape. */
  repoUrl: string;
  /** Branch or tag to analyse. */
  branch: string;
  /** Optional commit inside that branch, when the caller pins one. */
  commitSha?: string;
  /**
   * How the analysis scope is defined:
   * - FULL_REPOSITORY: analyse the entire repository tree
   * - FILES: analyse only the files listed in `paths`
   * - DIRECTORIES: analyse only the directories listed in `paths`
   */
  scopeType: 'FULL_REPOSITORY' | 'FILES' | 'DIRECTORIES';
  /**
   * Explicit file or directory paths to include/exclude when scopeType
   * is FILES or DIRECTORIES. Omitted for FULL_REPOSITORY.
   */
  paths?: string[];
  /**
   * Optional Jira/Linear sprint identifier used by the Changelog agent
   * to fetch issues for the sprint.
   */
  sprintId?: string;
}

/**
 * An analysis context returned by the backend after POST /contexts or GET /contexts/:id.
 * Progettazione §20.4 – AnalysisContextDto.
 */
export interface AnalysisContextDto {
  id: string;
  repoOwner: string;
  repoName: string;
  /** Whether the repository is private on GitHub. */
  isPrivate: boolean;
  /** The resolved commit SHA for the given ref. */
  resolvedSha: string;
  scopeType: 'FULL_REPOSITORY' | 'FILES' | 'DIRECTORIES';
  paths: string[];
  /** Programming languages detected in the repository. */
  detectedLanguages: string[];
  /** Estimated number of files in scope. */
  estimatedFileCount: number;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Severity levels used by security findings. */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** A plain-text or Markdown block (changelog, summary). */
export interface TextBlock {
  kind: 'text';
  order: number;
  markdown: string;
}

/** A structured security finding (OWASP category, location, explanation). */
export interface FindingBlock {
  kind: 'finding';
  order: number;
  owaspCategory: string;
  severity: Severity;
  filePath: string;
  startLine: number;
  endLine: number;
  explanation: string;
  remediation: string;
}

/** A policy violation discovered during a security-policy scan. */
export interface PolicyViolationBlock {
  kind: 'policy_violation';
  order: number;
  ruleId: string;
  ruleText: string;
  filePath: string;
  explanation: string;
  remediation: string;
}

/** A changelog entry (issue reference + title + detail). */
export interface ChangelogItemBlock {
  kind: 'changelog_item';
  order: number;
  issueRef: string;
  title: string;
  detail: string;
}

/** Discriminated union covering all block types in a report body. */
export type ReportBlock =
  | TextBlock
  | FindingBlock
  | PolicyViolationBlock
  | ChangelogItemBlock;

/**
 * A proposed code change (diff) generated by the Docs agent.
 * Carries a PR link once the change has been submitted.
 * ADR-FE-1: the PR link is the primary actionable element and must be
 * rendered prominently (not buried in the diff view).
 */
export interface Proposal {
  targetPath: string;
  diffUnified: string;
  language: string;
  prUrl?: string;
}

/**
 * Summary view of a report (used on the /reports list page).
 * Progettazione §20.4 – ReportSummaryDto.
 */
export interface ReportSummary {
  id: string;
  taskId: string;
  operation: OperationCode;
  status: 'COMPLETED' | 'FAILED';
  generatedAt: string;
  /** Human-readable title assigned by the backend (e.g. "README – my-org/my-repo"). */
  title: string;
  durationMs?: number;
}

/** Full report detail (used on the /reports/:id page). */
export interface Report extends ReportSummary {
  agentId: string;
  tokensConsumed?: number;
  summary?: string;
  error?: { kind: string; message: string; stage: string };
  body: ReportBlock[];
  proposal?: Proposal;
}

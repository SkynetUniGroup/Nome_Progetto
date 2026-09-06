// AUTH
export type UserRole = "DEVELOPER" | "SECURITY_AUDITOR" | "PROJECT_MANAGER";
export const USER_ROLES: UserRole[] = ["DEVELOPER", "SECURITY_AUDITOR", "PROJECT_MANAGER"];

export interface RegisterDto {
  firstName: string; // 1-40 char
  lastName: string; // 1-40 char
  email: string; // validated, unique
  password: string; // 8 char min, at least 1 letter and 1 digit
  role: UserRole; // once chosen, permanent
}

export interface UserProfileDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
}

export interface AuthTokenDto {
  accessToken: string; // JWT HS256, espires in 8h
}

export interface LoginDto {
  email: string;
  password: string;
}

// OPERATIONS
export type OperationCode =
  | "DOCS_README"
  | "DOCS_INLINE"
  | "DOCS_API"
  | "SECURITY_OWASP"
  | "SECURITY_POLICY"
  | "CHANGELOG_TECHNICAL"
  | "CHANGELOG_BUSINESS";

export const OPERATION_CODES: OperationCode[] = [
  "DOCS_README",
  "DOCS_INLINE",
  "DOCS_API",
  "SECURITY_OWASP",
  "SECURITY_POLICY",
  "CHANGELOG_TECHNICAL",
  "CHANGELOG_BUSINESS",
];

export type ScopeType = "FULL_REPOSITORY" | "FILES" | "DIRECTORIES";

// TASKS
export type TaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface TaskError {
  code: string;
  message: string;
  stage: string;
}

export type PendingInput =
  | { kind: "SPRINT_ID" }
  | { kind: "INCOMPLETE_TASKS"; taskIds: string[] }
  | { kind: "BUSINESS_CONFIRMATION"; technicalReportId: string }
  | null;

export type SubmitInputDto =
  | { kind: "SPRINT_ID"; sprintId: string }
  | { kind: "INCOMPLETE_TASKS"; action: "PROCEED" | "CANCEL" }
  | { kind: "BUSINESS_CONFIRMATION"; action: "PROCEED" | "CANCEL" };

export interface TaskDto {
  id: string;
  batchId: string | null;
  operation: OperationCode;
  status: TaskStatus;
  progressPercent: number;
  currentStage: string | null;
  reportId: string | null;
  error: TaskError | null;
  pendingInput: PendingInput;
}

// REPORTS
export type ReportStatus = "COMPLETED" | "FAILED";
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ReportError {
  code: string;
  message: string;
  stage: string;
}

export interface ReportContext {
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  branch: string;
  resolvedSha: string;
  scopeType: ScopeType;
  paths: string[];
}

export interface Proposal {
  targetPath: string;
  diffUnified: string;
  language: string;
  pullRequestUrl: string | null;
}

export interface ReportDto {
  id: string;
  taskId: string;
  operation: OperationCode;
  status: ReportStatus;
  title: string;
  summary: string | null;
  generatedAt: string;
  executionTimeMs: number | null;
  context: ReportContext;
  body: Block[];
  proposal?: Proposal;
  pendingAction: {
    kind: "BUSINESS_CONFIRMATION";
    taskId: string;
    actions: ("PROCEED" | "CANCEL")[];
  } | null;
  error?: ReportError;
}

export interface ReportSummaryDto {
  id: string;
  operation: OperationCode;
  status: ReportStatus;
  title: string;
  generatedAt: string;
}

export interface TextBlock {
  kind: "TEXT";
  markdown: string;
}

export interface FindingBlock {
  kind: "FINDING";
  category: string;
  severity: Severity;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  description: string;
  remediation: Remediation;
}

export type Remediation =
  | { kind: "SNIPPET"; language: string; code: string }
  | { kind: "TEXT"; text: string };

export interface PolicyViolationBlock {
  kind: "POLICY_VIOLATION";
  ruleId: string;
  ruleText: string;
  filePath: string;
  explanation: string;
  severity: Severity;
  remediation: Remediation;
}

export interface ComplexityWarningBlock {
  kind: "COMPLEXITY_WARNING";
  severity: "INFO";
  filePath: string;
  startLine: number;
  endLine: number;
  explanation: string;
}

export interface ChangelogItemBlock {
  kind: "CHANGELOG_ITEM";
  issueRef: string;
  title: string;
  detail: string;
}

export type Block =
  | TextBlock
  | FindingBlock
  | PolicyViolationBlock
  | ComplexityWarningBlock
  | ChangelogItemBlock;

// CONTEXTS
export interface CreateContextDto {
  repoUrl: string;
  branch: string;
  commitSha?: string;
  scopeType: ScopeType;
  paths?: string[];
}

export interface AnalysisContextDto {
  id: string;
  repoOwner: string;
  repoName: string;
  isPrivate: boolean;
  branch: string;
  resolvedSha: string;
  scopeType: ScopeType;
  detectedLanguages: string[];
  estimatedFileCount: number;
  nonEnglishReadmeDetected: boolean; // TODO connect to the frontend
}

// CREDENTIALS
export type CredentialsStatus = "UNKNOWN" | "MISSING" | "CONNECTED" | "INVALID";

export interface CreateCredentialDto {
  provider: string;
  token: string;
}

export interface ServiceCredentialDto {
  id: string;
  provider: string;
  connectedAt: string; // ISO 8601
}

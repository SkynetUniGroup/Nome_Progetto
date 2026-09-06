import { ScopeType } from "../../common/domain-types";

export class AnalysisContextDto {
  id!: string;
  repoOwner!: string;
  repoName!: string;
  isPrivate!: boolean;
  branch!: string;
  resolvedSha!: string;
  scopeType!: ScopeType;
  detectedLanguages!: string[];
  estimatedFileCount!: number;
  // RV.8 — no dedicated field exists anywhere in the frontend contract for
  // this; the design doc only says it "produces the same non-blocking
  // warning as RF.24" (same UI treatment, above the tree). Named explicitly
  // rather than folded into detectedLanguages, which is about programming
  // languages, not the README's natural language — confirm this field name
  // with whoever wires up the frontend before relying on it.
  nonEnglishReadmeDetected!: boolean;
}

import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import type { ScopeType } from "../../common/domain-types";

export type AnalysisContextDocument = HydratedDocument<AnalysisContext>;

@Schema({ timestamps: true })
export class AnalysisContext {
  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  repoUrl!: string;

  @Prop({ required: true })
  repoOwner!: string;

  @Prop({ required: true })
  repoName!: string;

  @Prop({ required: true })
  isPrivate!: boolean;

  @Prop({ required: true })
  branch!: string;

  // The commit this context is pinned to — what makes a report reproducible
  // even after new commits land on the branch.
  @Prop({ required: true })
  resolvedSha!: string;

  @Prop({
    type: String,
    required: true,
    enum: ["FULL_REPOSITORY", "FILES", "DIRECTORIES"],
  })
  scopeType!: ScopeType;

  @Prop({ type: [String], default: [] })
  paths!: string[];

  @Prop({ type: [String], default: [] })
  detectedLanguages!: string[];

  @Prop()
  estimatedFileCount!: number;

  // RV.8 — see AnalysisContextDto for why this field exists and isn't part
  // of detectedLanguages.
  @Prop({ default: false })
  nonEnglishReadmeDetected!: boolean;

  // No sprintId here — it moved to Task, since a context can be shared by
  // several operations in one batch while the Sprint ID only concerns the
  // Changelog ones.
}

export const AnalysisContextSchema = SchemaFactory.createForClass(AnalysisContext);

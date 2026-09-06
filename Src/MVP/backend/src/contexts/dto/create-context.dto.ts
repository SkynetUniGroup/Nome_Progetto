import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";
import { GITHUB_REPO_URL_REGEX } from "../github-url";
import type { ScopeType } from "../../common/domain-types";

const SCOPE_TYPES: ScopeType[] = ["FULL_REPOSITORY", "FILES", "DIRECTORIES"];

export class CreateContextDto {
  @Matches(GITHUB_REPO_URL_REGEX, {
    message: "repoUrl must be a GitHub repository URL (https://github.com/:owner/:repo)",
  })
  repoUrl!: string;

  @IsString()
  @IsNotEmpty()
  branch!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  commitSha?: string;

  @IsIn(SCOPE_TYPES)
  scopeType!: ScopeType;

  // Non-emptiness (for FILES/DIRECTORIES) and emptiness (for
  // FULL_REPOSITORY) are cross-field rules that depend on scopeType — not
  // expressible cleanly with class-validator decorators alone, so that
  // check lives in ContextsService instead (RF.29).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  paths?: string[];
}

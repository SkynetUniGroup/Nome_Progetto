import { IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";
import { GITHUB_REPO_URL_REGEX } from "../github-url";

export class RepoTreeQueryDto {
  @Matches(GITHUB_REPO_URL_REGEX, {
    message: "repoUrl must be a GitHub repository URL (https://github.com/:owner/:repo)",
  })
  repoUrl!: string;

  @IsString()
  @IsNotEmpty()
  branch!: string;

  // Omitted means "use branch's current HEAD" — resolved by
  // RepositoriesService, not here.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  commitSha?: string;
}

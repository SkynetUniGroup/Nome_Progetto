import { Matches } from "class-validator";
import { GITHUB_REPO_URL_REGEX } from "../github-url";

export class RepoUrlQueryDto {
  @Matches(GITHUB_REPO_URL_REGEX, {
    message: "repoUrl must be a GitHub repository URL (https://github.com/:owner/:repo)",
  })
  repoUrl!: string;
}

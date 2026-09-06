import { TreeNode } from "../../github/github-client.types";

export class RepositoryTreeDto {
  entries!: TreeNode[];
  detectedLanguages!: string[];
}

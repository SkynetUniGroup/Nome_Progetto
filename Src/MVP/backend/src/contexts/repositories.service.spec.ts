import { Test, TestingModule } from "@nestjs/testing";
import { RepositoriesService } from "./repositories.service";
import { CredentialsService } from "../credentials/credentials.service";
import { GithubClientService } from "../github/github-client.service";
import { RepoResolverService } from "./repo-resolver.service";

describe("RepositoriesService", () => {
  let service: RepositoriesService;
  let credentials: { getDecryptedToken: vi.fn };
  let github: {
    listRepositories: vi.fn;
    listRefs: vi.fn;
    resolveRefToSha: vi.fn;
    getTree: vi.fn;
  };
  let repoResolver: { resolve: vi.fn };

  beforeEach(async () => {
    credentials = { getDecryptedToken: vi.fn().mockResolvedValue("token") };
    github = {
      listRepositories: vi.fn(),
      listRefs: vi.fn(),
      resolveRefToSha: vi.fn(),
      getTree: vi.fn(),
    };
    repoResolver = {
      resolve: vi.fn().mockResolvedValue({
        owner: "owner",
        repo: "repo",
        isPrivate: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepositoriesService,
        { provide: CredentialsService, useValue: credentials },
        { provide: GithubClientService, useValue: github },
        { provide: RepoResolverService, useValue: repoResolver },
      ],
    }).compile();

    service = module.get(RepositoriesService);
  });

  describe("list", () => {
    it("returns the caller's repositories using their decrypted token", async () => {
      github.listRepositories.mockResolvedValue([
        {
          owner: "owner",
          name: "repo",
          isPrivate: false,
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
        },
      ]);

      const result = await service.list("user1");

      expect(credentials.getDecryptedToken).toHaveBeenCalledWith("user1", "GITHUB");
      expect(github.listRepositories).toHaveBeenCalledWith("token");
      expect(result).toHaveLength(1);
    });
  });

  describe("refs", () => {
    it("resolves the repoUrl before listing refs", async () => {
      github.listRefs.mockResolvedValue({
        branches: [{ name: "main", sha: "sha1" }],
        tags: [],
      });

      const result = await service.refs("user1", "https://github.com/owner/repo");

      expect(repoResolver.resolve).toHaveBeenCalledWith("token", "https://github.com/owner/repo");
      expect(github.listRefs).toHaveBeenCalledWith("token", "owner", "repo");
      expect(result.branches).toHaveLength(1);
    });
  });

  describe("tree", () => {
    it("uses the supplied commitSha directly, without resolving the branch", async () => {
      github.getTree.mockResolvedValue([]);

      await service.tree("user1", "https://github.com/owner/repo", "main", "sha-from-caller");

      expect(github.resolveRefToSha).not.toHaveBeenCalled();
      expect(github.getTree).toHaveBeenCalledWith("token", "owner", "repo", "sha-from-caller");
    });

    it("resolves the branch's HEAD when no commitSha is given", async () => {
      github.resolveRefToSha.mockResolvedValue("resolved-sha");
      github.getTree.mockResolvedValue([]);

      await service.tree("user1", "https://github.com/owner/repo", "main");

      expect(github.resolveRefToSha).toHaveBeenCalledWith("token", "owner", "repo", "main");
      expect(github.getTree).toHaveBeenCalledWith("token", "owner", "repo", "resolved-sha");
    });

    it("returns the tree entries and the deduplicated, filtered set of detected languages", async () => {
      github.getTree.mockResolvedValue([
        { path: "src/a.ts", type: "file", sizeBytes: 1 },
        { path: "src/b.ts", type: "file", sizeBytes: 1 },
        { path: "src/main.py", type: "file", sizeBytes: 1 },
        { path: "README.md", type: "file", sizeBytes: 1 }, // unknown extension
        { path: "src", type: "dir", sizeBytes: 0 }, // directories never count
      ]);

      const result = await service.tree("user1", "https://github.com/owner/repo", "main", "sha");

      expect(result.entries).toHaveLength(5);
      expect(result.detectedLanguages.sort()).toEqual(["python", "typescript"]);
    });
  });
});

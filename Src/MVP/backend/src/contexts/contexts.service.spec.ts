import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ContextsService } from "./contexts.service";
import { AnalysisContext } from "./schemas/analysis-context.schema";
import { CredentialsService } from "../credentials/credentials.service";
import { GithubClientService } from "../github/github-client.service";
import { RepoResolverService } from "./repo-resolver.service";
import { FRANC } from "./franc.provider";
import { CreateContextDto } from "./dto/create-context.dto";

describe("ContextsService", () => {
  let service: ContextsService;
  let model: {
    create: vi.fn<Promise<unknown>, [Record<string, unknown>]>;
  };
  let credentials: { getDecryptedToken: vi.fn };
  let repoResolver: { resolve: vi.fn };
  let franc: vi.fn<string, [string]>;
  let github: {
    listRefs: vi.fn;
    compareCommits: vi.fn;
    getTree: vi.fn;
    getReadme: vi.fn;
  };

  const baseDto: CreateContextDto = {
    repoUrl: "https://github.com/owner/repo",
    branch: "main",
    scopeType: "FULL_REPOSITORY",
  };

  const fullTree = [
    { path: "src", type: "dir" as const, sizeBytes: 0 },
    { path: "src/index.ts", type: "file" as const, sizeBytes: 10 },
    { path: "src/utils.py", type: "file" as const, sizeBytes: 10 },
    { path: "docs", type: "dir" as const, sizeBytes: 0 },
    { path: "docs/notes.md", type: "file" as const, sizeBytes: 10 },
  ];

  function createdDocument(overrides: Record<string, unknown> = {}) {
    return {
      _id: { toString: () => "ctx1" },
      repoOwner: "owner",
      repoName: "repo",
      isPrivate: false,
      branch: "main",
      resolvedSha: "branch-head-sha",
      scopeType: "FULL_REPOSITORY",
      paths: [],
      detectedLanguages: ["typescript", "python"],
      estimatedFileCount: 3,
      nonEnglishReadmeDetected: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    model = {
      create: vi.fn<Promise<unknown>, [Record<string, unknown>]>(),
    };
    credentials = { getDecryptedToken: vi.fn().mockResolvedValue("token") };
    repoResolver = {
      resolve: jest.fn().mockResolvedValue({ owner: "owner", repo: "repo", isPrivate: false }),
    };
    github = {
      listRefs: vi.fn().mockResolvedValue({
        branches: [{ name: "main", sha: "branch-head-sha" }],
        tags: [],
      }),
      compareCommits: vi.fn(),
      getTree: vi.fn().mockResolvedValue(fullTree),
      getReadme: vi.fn().mockResolvedValue(null),
    };
    // Defaults to 'eng' so every test that doesn't care about RV.8 gets a
    // non-warning result without having to set this up itself.
    franc = vi.fn<string, [string]>().mockReturnValue("eng");
    model.create.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve(createdDocument(doc)),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextsService,
        { provide: getModelToken(AnalysisContext.name), useValue: model },
        { provide: CredentialsService, useValue: credentials },
        { provide: GithubClientService, useValue: github },
        { provide: RepoResolverService, useValue: repoResolver },
        { provide: FRANC, useValue: franc },
      ],
    }).compile();

    service = module.get(ContextsService);
  });

  describe("happy paths", () => {
    it("FULL_REPOSITORY: persists with every file counted and no paths", async () => {
      const result = await service.create("user1", baseDto);

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeType: "FULL_REPOSITORY",
          paths: [],
          resolvedSha: "branch-head-sha",
          estimatedFileCount: 3, // 3 files in fullTree
        }),
      );
      const createdWith = model.create.mock.calls[0][0] as Record<string, unknown> & {
        detectedLanguages: string[];
      };
      expect(createdWith.detectedLanguages.sort()).toEqual(["python", "typescript"]);
      expect(result.id).toBe("ctx1");
    });

    it("FILES: persists the normalized paths and counts exactly them", async () => {
      await service.create("user1", {
        ...baseDto,
        scopeType: "FILES",
        paths: ["/src/index.ts", "src/index.ts", "docs/notes.md"],
      });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeType: "FILES",
          paths: ["src/index.ts", "docs/notes.md"], // deduplicated
          estimatedFileCount: 2,
        }),
      );
    });

    it("DIRECTORIES: counts every file recursively under the selected prefix", async () => {
      await service.create("user1", {
        ...baseDto,
        scopeType: "DIRECTORIES",
        paths: ["src"],
      });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeType: "DIRECTORIES",
          paths: ["src"],
          estimatedFileCount: 2, // src/index.ts, src/utils.py
        }),
      );
    });

    it("anchors to the supplied commitSha instead of the branch HEAD when given", async () => {
      github.compareCommits.mockResolvedValue({ status: "identical" });

      await service.create("user1", { ...baseDto, commitSha: "pinned-sha" });

      expect(github.compareCommits).toHaveBeenCalledWith(
        "token",
        "owner",
        "repo",
        "pinned-sha",
        "branch-head-sha",
      );
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ resolvedSha: "pinned-sha" }),
      );
    });

    it("fetches the tree exactly once, reused by both language detection and scope validation", async () => {
      await service.create("user1", {
        ...baseDto,
        scopeType: "FILES",
        paths: ["src/index.ts"],
      });

      expect(github.getTree).toHaveBeenCalledTimes(1);
    });
  });

  describe("step 4 — branch existence", () => {
    it("throws NotFoundException when the branch does not exist", async () => {
      github.listRefs.mockResolvedValue({ branches: [], tags: [] });

      await expect(service.create("user1", baseDto)).rejects.toBeInstanceOf(NotFoundException);
      expect(model.create).not.toHaveBeenCalled();
    });
  });

  describe("step 5 — commit membership", () => {
    it.each(["behind", "diverged"] as const)(
      "rejects with 422 when compareCommits reports %s",
      async (status) => {
        github.compareCommits.mockResolvedValue({ status });

        await expect(
          service.create("user1", { ...baseDto, commitSha: "stray-sha" }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(model.create).not.toHaveBeenCalled();
      },
    );

    it('accepts "ahead" as valid membership', async () => {
      github.compareCommits.mockResolvedValue({ status: "ahead" });

      await expect(
        service.create("user1", { ...baseDto, commitSha: "ancestor-sha" }),
      ).resolves.toBeDefined();
    });
  });

  describe("step 8 — non-empty scope", () => {
    it("rejects FILES with no paths", async () => {
      await expect(
        service.create("user1", { ...baseDto, scopeType: "FILES", paths: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects paths that normalize away to nothing", async () => {
      await expect(
        service.create("user1", {
          ...baseDto,
          scopeType: "FILES",
          paths: [".", "..", "/"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects FULL_REPOSITORY with paths supplied", async () => {
      await expect(
        service.create("user1", {
          ...baseDto,
          scopeType: "FULL_REPOSITORY",
          paths: ["src"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("step 9 — scope existence", () => {
    it("rejects a path that does not exist in the tree", async () => {
      await expect(
        service.create("user1", {
          ...baseDto,
          scopeType: "FILES",
          paths: ["nope.ts"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a FILES path that is actually a directory", async () => {
      await expect(
        service.create("user1", {
          ...baseDto,
          scopeType: "FILES",
          paths: ["src"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a DIRECTORIES path that is actually a file", async () => {
      await expect(
        service.create("user1", {
          ...baseDto,
          scopeType: "DIRECTORIES",
          paths: ["src/index.ts"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("RV.8 — README language check", () => {
    it("is false when the repo has no README", async () => {
      github.getReadme.mockResolvedValue(null);

      const result = await service.create("user1", baseDto);
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ nonEnglishReadmeDetected: false }),
      );
      expect(result.nonEnglishReadmeDetected).toBe(false);
    });

    it("is true when franc detects the README as non-English", async () => {
      github.getReadme.mockResolvedValue({
        path: "README.md",
        content:
          "Questo progetto aiuta gli sviluppatori a gestire le loro attività quotidiane in modo semplice ed efficace.",
        sha: "readme-sha",
        language: "unknown",
      });
      franc.mockReturnValue("ita");

      await service.create("user1", baseDto);
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ nonEnglishReadmeDetected: true }),
      );
    });

    it("does not fail context creation when fetching the README throws", async () => {
      github.getReadme.mockRejectedValue(new Error("network blip"));

      await expect(service.create("user1", baseDto)).resolves.toBeDefined();
    });
  });
});

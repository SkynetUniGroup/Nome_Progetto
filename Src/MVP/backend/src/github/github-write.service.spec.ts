// Same mocking approach as github-client.service.spec.ts: a fake Octokit so
// these stay fast, deterministic unit tests of our own branch/commit/PR
// sequencing rather than real network calls.
const mockRequest = vi.fn();
vi.fn("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    request: mockRequest,
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { GithubWriteService } from "./github-write.service";
import { GithubClientService } from "./github-client.service";
import { AppException } from "../common/exceptions/app.exception";

describe("GithubWriteService", () => {
  let service: GithubWriteService;
  let githubClient: {
    resolveRefToSha: vi.fn;
    getFileContent: vi.fn;
  };

  const change = {
    operationCode: "DOCS_README",
    targetPath: "README.md",
    diffUnified: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
    title: "Update README",
  };

  beforeEach(async () => {
    mockRequest.mockReset();
    githubClient = {
      resolveRefToSha: vi.fn().mockResolvedValue("base-sha"),
      getFileContent: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "old\n",
        sha: "file-sha",
        language: "unknown",
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [GithubWriteService, { provide: GithubClientService, useValue: githubClient }],
    }).compile();

    service = module.get(GithubWriteService);
  });

  it("creates a branch, commits the patched file, opens a PR, and returns its URL", async () => {
    mockRequest
      .mockResolvedValueOnce({}) // create ref
      .mockResolvedValueOnce({}) // put contents
      .mockResolvedValueOnce({
        data: { html_url: "https://github.com/owner/repo/pull/7" },
      }); // create PR

    const url = await service.openPullRequestForProposal("token", "owner", "repo", "main", change);

    expect(url).toBe("https://github.com/owner/repo/pull/7");
    expect(githubClient.resolveRefToSha).toHaveBeenCalledWith("token", "owner", "repo", "main");

    // Branch creation: namespaced under codeguardian/<scope>/<id>, anchored
    // at the resolved base SHA.
    const createRefCall = mockRequest.mock.calls[0] as [string, { ref: string; sha: string }];
    expect(createRefCall[0]).toBe("POST /repos/{owner}/{repo}/git/refs");
    expect(createRefCall[1].ref).toMatch(/^refs\/heads\/codeguardian\/docs-readme\/[0-9a-f]{8}$/);
    expect(createRefCall[1].sha).toBe("base-sha");

    // Commit: patched content, existing file's sha passed through (update,
    // not create).
    const putContentsCall = mockRequest.mock.calls[1] as [
      string,
      { sha?: string; content: string },
    ];
    expect(putContentsCall[0]).toBe("PUT /repos/{owner}/{repo}/contents/{path}");
    expect(putContentsCall[1].sha).toBe("file-sha");
    expect(Buffer.from(putContentsCall[1].content, "base64").toString()).toBe("new\n");

    // PR: head is the branch just created, base is the original branch.
    const createPrCall = mockRequest.mock.calls[2] as [string, { base: string; head: string }];
    expect(createPrCall[0]).toBe("POST /repos/{owner}/{repo}/pulls");
    expect(createPrCall[1].base).toBe("main");
    expect(createPrCall[1].head).toBe(createRefCall[1].ref.replace("refs/heads/", ""));
  });

  it("treats a missing file as new content with no sha to update, when the agent proposes a brand-new file", async () => {
    githubClient.getFileContent.mockRejectedValue({ status: 404 });
    mockRequest
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        data: { html_url: "https://github.com/owner/repo/pull/8" },
      });

    const newFileChange = {
      ...change,
      diffUnified: "--- /dev/null\n+++ b/README.md\n@@ -0,0 +1 @@\n+hello\n",
    };

    await service.openPullRequestForProposal("token", "owner", "repo", "main", newFileChange);

    const putContentsCall = mockRequest.mock.calls[1] as [
      string,
      { sha?: string; content: string },
    ];
    expect(putContentsCall[1].sha).toBeUndefined();
    expect(Buffer.from(putContentsCall[1].content, "base64").toString()).toBe("hello\n");
  });

  it("throws PR_CREATION_FAILED when GitHub refuses the write with 403", async () => {
    mockRequest.mockRejectedValue({ status: 403, message: "Forbidden" });

    await expect(
      service.openPullRequestForProposal("token", "owner", "repo", "main", change),
    ).rejects.toBeInstanceOf(AppException);

    try {
      await service.openPullRequestForProposal("token", "owner", "repo", "main", change);
      fail("expected rejection");
    } catch (error) {
      expect((error as AppException).code).toBe("PR_CREATION_FAILED");
    }
  });

  it("leaves a network failure uncaught so it falls through to UPSTREAM", async () => {
    mockRequest.mockRejectedValue({ status: 502, message: "Bad Gateway" });

    await expect(
      service.openPullRequestForProposal("token", "owner", "repo", "main", change),
    ).rejects.not.toBeInstanceOf(AppException);
  });

  it("throws a plain error, not PR_CREATION_FAILED, when the diff does not apply", async () => {
    githubClient.getFileContent.mockResolvedValue({
      path: "README.md",
      content: "completely different content",
      sha: "file-sha",
      language: "unknown",
    });

    await expect(
      service.openPullRequestForProposal("token", "owner", "repo", "main", change),
    ).rejects.not.toBeInstanceOf(AppException);
    // No GitHub call should have been made at all: the patch is checked
    // before any write is attempted.
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

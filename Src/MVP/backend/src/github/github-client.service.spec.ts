// Mocked so these stay fast, deterministic unit tests of our own
// cache/rate-limit logic rather than making real network calls — Jest can
// load the real @octokit/rest package fine now (see package.json's
// transformIgnorePatterns), this mock is a testing choice, not a workaround.
type HookBeforeCallback = (options: { method: string; url: string }) => void;

const mockRequest = vi.fn();
const mockHookBefore = vi.fn<void, [string, HookBeforeCallback]>();
vi.fn("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    request: mockRequest,
    hook: { after: vi.fn(), before: mockHookBefore },
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { createMockRedis, RedisTestModule } from "@nestjs-modules/ioredis";
import { GithubClientService } from "./github-client.service";

describe("GithubClientService — cache behavior", () => {
  let service: GithubClientService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRequest.mockReset();
    mockHookBefore.mockReset();
    redis = createMockRedis();

    const module: TestingModule = await Test.createTestingModule({
      imports: [RedisTestModule.forTest(undefined, redis)],
      providers: [GithubClientService],
    }).compile();

    service = module.get(GithubClientService);
  });

  describe("getTree", () => {
    it("returns the cached value and never calls GitHub on a cache hit", async () => {
      const cachedTree = [{ path: "a.ts", type: "file", sizeBytes: 10 }];
      redis.get.mockResolvedValue(JSON.stringify(cachedTree));

      const result = await service.getTree("token", "owner", "repo", "sha123");

      expect(result).toEqual(cachedTree);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("calls GitHub and populates the cache on a miss, keyed on owner/repo@sha", async () => {
      redis.get.mockResolvedValue(null);
      mockRequest.mockResolvedValue({
        headers: {},
        data: {
          tree: [
            { path: "src", type: "tree", size: 0 },
            { path: "src/index.ts", type: "blob", size: 42 },
            { path: "vendor", type: "commit", size: 0 }, // submodule
          ],
        },
      });

      const result = await service.getTree("token", "owner", "repo", "sha123");

      expect(result).toEqual([
        { path: "src", type: "dir", sizeBytes: 0 },
        { path: "src/index.ts", type: "file", sizeBytes: 42 },
      ]);
      expect(result).toHaveLength(2); // the submodule entry was excluded

      expect(redis.set).toHaveBeenCalledWith(
        "github:tree:owner/repo@sha123",
        JSON.stringify(result),
        "EX",
        86400,
      );
    });
  });

  describe("verifyToken", () => {
    it("returns the scopes parsed from the X-OAuth-Scopes header", async () => {
      mockRequest.mockResolvedValue({
        headers: { "x-oauth-scopes": "repo, gist" },
        data: {},
      });

      const result = await service.verifyToken("token");

      expect(result).toEqual({ scopes: ["repo", "gist"] });
    });

    it("returns an empty scope list when the header is absent", async () => {
      mockRequest.mockResolvedValue({ headers: {}, data: {} });

      const result = await service.verifyToken("token");

      expect(result).toEqual({ scopes: [] });
    });

    it("propagates the error when GitHub rejects the token", async () => {
      mockRequest.mockRejectedValue({
        status: 401,
        message: "Bad credentials",
      });

      await expect(service.verifyToken("bad-token")).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe("getFileContent", () => {
    it("returns the cached value and never calls GitHub on a cache hit", async () => {
      const cachedFile = {
        path: "a.ts",
        content: "x",
        sha: "filesha",
        language: "typescript",
      };
      redis.get.mockResolvedValue(JSON.stringify(cachedFile));

      const result = await service.getFileContent("token", "owner", "repo", "a.ts", "sha123");

      expect(result).toEqual(cachedFile);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("decodes base64 content and populates the cache on a miss, keyed on owner/repo@ref:path", async () => {
      redis.get.mockResolvedValue(null);
      mockRequest.mockResolvedValue({
        headers: {},
        data: {
          type: "file",
          path: "src/index.ts",
          sha: "filesha",
          content: Buffer.from("console.log(1)").toString("base64"),
        },
      });

      const result = await service.getFileContent(
        "token",
        "owner",
        "repo",
        "src/index.ts",
        "sha123",
      );

      expect(result).toEqual({
        path: "src/index.ts",
        content: "console.log(1)",
        sha: "filesha",
        language: "typescript",
      });

      expect(redis.set).toHaveBeenCalledWith(
        "github:file:owner/repo@sha123:src/index.ts",
        JSON.stringify(result),
        "EX",
        86400,
      );
    });
  });

  describe("read-only enforcement", () => {
    it("registers an Octokit hook that refuses any non-GET request", async () => {
      mockRequest.mockResolvedValue({ headers: {}, data: {} });
      await service.verifyToken("token");

      const hookCallback = mockHookBefore.mock.calls[0][1];

      expect(() => hookCallback({ method: "POST", url: "/repos/owner/repo/pulls" })).toThrow();
      expect(() => hookCallback({ method: "GET", url: "/repos/owner/repo" })).not.toThrow();
    });
  });
});

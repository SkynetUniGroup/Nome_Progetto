import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { InternalGithubController } from "./internal-github.controller";
import { InternalTaskContextResolver } from "./internal-task-context.resolver";
import { GithubClientService } from "./github-client.service";
import { AccessLog } from "./schemas/access-log.schema";
import { InternalAuthGuard } from "../common/guards/internal-auth.guard";

describe("InternalGithubController", () => {
  let controller: InternalGithubController;
  let resolver: { resolve: vi.fn };
  let github: {
    getTree: vi.fn;
    getFileContent: vi.fn;
    listIssues: vi.fn;
    getIssueDetail: vi.fn;
  };
  let accessLogModel: { create: vi.fn };

  // A real 24-hex-char id: logAccess constructs a genuine Types.ObjectId
  // from this (not mocked), unlike the resolver's `taskId` param elsewhere,
  // which only ever reaches mocked model methods.
  const taskId = "507f1f77bcf86cd799439011";

  const resolved = {
    taskId,
    owner: "octocat",
    repo: "hello-world",
    resolvedSha: "abc123",
    token: "ghp_decrypted",
  };

  beforeEach(async () => {
    resolver = { resolve: vi.fn().mockResolvedValue(resolved) };
    github = {
      getTree: vi.fn(),
      getFileContent: vi.fn(),
      listIssues: vi.fn(),
      getIssueDetail: vi.fn(),
    };
    accessLogModel = { create: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalGithubController],
      providers: [
        { provide: InternalTaskContextResolver, useValue: resolver },
        { provide: GithubClientService, useValue: github },
        { provide: getModelToken(AccessLog.name), useValue: accessLogModel },
      ],
    })
      // This spec is about the controller's own logic; InternalAuthGuard has
      // its own dedicated spec covering the HMAC verification itself.
      .overrideGuard(InternalAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InternalGithubController);
  });

  it("tree: resolves context, calls getTree with owner/repo/sha, and logs the access", async () => {
    const tree = [{ path: "a.ts", type: "file", sizeBytes: 1 }];
    github.getTree.mockResolvedValue(tree);

    const result = await controller.tree({ taskId });

    expect(github.getTree).toHaveBeenCalledWith(
      "ghp_decrypted",
      "octocat",
      "hello-world",
      "abc123",
    );
    expect(result).toBe(tree);
    expect(accessLogModel.create).toHaveBeenCalledWith({
      taskId: new Types.ObjectId(taskId),
      endpoint: "tree",
      resource: "octocat/hello-world@abc123",
    });
  });

  it("file: passes the requested path through and logs owner/repo@sha:path", async () => {
    const file = { path: "src/a.ts", content: "x", sha: "s", language: "ts" };
    github.getFileContent.mockResolvedValue(file);

    const result = await controller.file({
      taskId,
      path: "src/a.ts",
    });

    expect(github.getFileContent).toHaveBeenCalledWith(
      "ghp_decrypted",
      "octocat",
      "hello-world",
      "src/a.ts",
      "abc123",
    );
    expect(result).toBe(file);
    expect(accessLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "file",
        resource: "octocat/hello-world@abc123:src/a.ts",
      }),
    );
  });

  it("issues: lists issues when no issueNumber is given", async () => {
    const issues = [{ number: 1, title: "t", state: "open" }];
    github.listIssues.mockResolvedValue(issues);

    const result = await controller.issues({ taskId, state: "open" });

    expect(github.listIssues).toHaveBeenCalledWith(
      "ghp_decrypted",
      "octocat",
      "hello-world",
      "open",
    );
    expect(github.getIssueDetail).not.toHaveBeenCalled();
    expect(result).toBe(issues);
    expect(accessLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "issues",
        resource: "octocat/hello-world?state=open",
      }),
    );
  });

  it("issues: fetches a single issue detail when issueNumber is given", async () => {
    const detail = { number: 5, title: "t", state: "open", body: "x" };
    github.getIssueDetail.mockResolvedValue(detail);

    const result = await controller.issues({ taskId, issueNumber: 5 });

    expect(github.getIssueDetail).toHaveBeenCalledWith(
      "ghp_decrypted",
      "octocat",
      "hello-world",
      5,
    );
    expect(github.listIssues).not.toHaveBeenCalled();
    expect(result).toBe(detail);
    expect(accessLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "issues",
        resource: "octocat/hello-world#5",
      }),
    );
  });
});

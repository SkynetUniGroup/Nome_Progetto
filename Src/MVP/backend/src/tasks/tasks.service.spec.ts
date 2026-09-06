import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { getQueueToken } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TasksService } from "./tasks.service";
import { Task } from "./schemas/task.schema";
import { AnalysisContext } from "../contexts/schemas/analysis-context.schema";
import { CredentialsService } from "../credentials/credentials.service";
import { AgentRegistry } from "../operations/agent-registry.service";
import { EventsGateway } from "../events/events.gateway";
import { UsageLimitService } from "./usage-limit.service";

describe("TasksService", () => {
  let service: TasksService;
  let taskModel: {
    findOne: vi.fn;
    find: vi.fn;
    insertMany: vi.fn;
  };
  let contextModel: { findOne: vi.fn };
  let credentials: { hasCredential: vi.fn };
  let agentRegistry: { getForRole: vi.fn };
  let events: { emitTaskUpdated: vi.fn };
  let queue: { addBulk: vi.fn };
  let usageLimit: { checkAndIncrement: vi.fn };

  const developer = { userId: "user1", role: "DEVELOPER" as const };

  beforeEach(async () => {
    taskModel = { findOne: vi.fn(), find: vi.fn(), insertMany: vi.fn() };
    contextModel = { findOne: vi.fn() };
    credentials = { hasCredential: vi.fn() };
    agentRegistry = { getForRole: vi.fn() };
    events = { emitTaskUpdated: vi.fn() };
    queue = { addBulk: vi.fn() };
    // Passes by default — only the dedicated usage-limit tests below need
    // it to reject, everything else is testing the other three checks.
    usageLimit = { checkAndIncrement: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: getModelToken(Task.name), useValue: taskModel },
        {
          provide: getModelToken(AnalysisContext.name),
          useValue: contextModel,
        },
        { provide: CredentialsService, useValue: credentials },
        { provide: AgentRegistry, useValue: agentRegistry },
        { provide: EventsGateway, useValue: events },
        { provide: UsageLimitService, useValue: usageLimit },
        { provide: getQueueToken("tasks"), useValue: queue },
      ],
    }).compile();

    service = module.get(TasksService);
  });

  describe("createBatch", () => {
    it("rejects an empty operations array with 400, before touching the database", async () => {
      await expect(
        service.createBatch(developer, { contextId: "ctx1", operations: [] }),
      ).rejects.toThrow(BadRequestException);
      expect(contextModel.findOne).not.toHaveBeenCalled();
    });

    it("rejects when the context does not exist or is not owned by the caller", async () => {
      contextModel.findOne.mockResolvedValue(null);

      await expect(
        service.createBatch(developer, {
          contextId: "ctx1",
          operations: ["DOCS_README"],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(contextModel.findOne).toHaveBeenCalledWith({
        _id: "ctx1",
        userId: "user1",
      });
    });

    it("rejects when no GitHub credential is configured", async () => {
      contextModel.findOne.mockResolvedValue({ _id: "ctx1" });
      credentials.hasCredential.mockResolvedValue(false);

      await expect(
        service.createBatch(developer, {
          contextId: "ctx1",
          operations: ["DOCS_README"],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects the whole batch with 403 if any operation is not permitted for the role", async () => {
      contextModel.findOne.mockResolvedValue({ _id: "ctx1" });
      credentials.hasCredential.mockResolvedValue(true);
      agentRegistry.getForRole.mockReturnValue([
        {
          code: "DOCS_README",
          displayName: "",
          description: "",
          agent: "DOCS",
        },
      ]);

      await expect(
        service.createBatch(developer, {
          contextId: "ctx1",
          operations: ["DOCS_README", "SECURITY_OWASP"],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(taskModel.insertMany).not.toHaveBeenCalled();
    });

    it("deduplicates operations, persists one Task per operation under a shared batchId, and enqueues one job each", async () => {
      contextModel.findOne.mockResolvedValue({ _id: "ctx1" });
      credentials.hasCredential.mockResolvedValue(true);
      agentRegistry.getForRole.mockReturnValue([
        {
          code: "DOCS_README",
          displayName: "",
          description: "",
          agent: "DOCS",
        },
        {
          code: "DOCS_INLINE",
          displayName: "",
          description: "",
          agent: "DOCS",
        },
      ]);
      taskModel.insertMany.mockResolvedValue([
        { id: "task1", batchId: "batchA" },
        { id: "task2", batchId: "batchA" },
      ]);

      const result = await service.createBatch(developer, {
        contextId: "ctx1",
        operations: ["DOCS_README", "DOCS_README", "DOCS_INLINE"],
      });

      // batchId isn't a fixed fixture value — it's generated per call and
      // echoed back in the response, so assert against result.batchId
      // rather than hardcoding it, to prove the *same* id was used for both
      // documents, not just that insertMany received two arbitrary ones.
      expect(result.taskIds).toEqual(["task1", "task2"]);
      expect(typeof result.batchId).toBe("string");
      expect(taskModel.insertMany).toHaveBeenCalledWith([
        expect.objectContaining({
          operation: "DOCS_README",
          batchId: result.batchId,
        }),
        expect.objectContaining({
          operation: "DOCS_INLINE",
          batchId: result.batchId,
        }),
      ]);
      expect(queue.addBulk).toHaveBeenCalledWith([
        { name: "run-task", data: { taskId: "task1" } },
        { name: "run-task", data: { taskId: "task2" } },
      ]);
      // 2, not 3: the usage check is charged against the deduplicated
      // count — the same number of Tasks actually created — not the raw
      // request body.
      expect(usageLimit.checkAndIncrement).toHaveBeenCalledWith("user1", 2);
    });

    it("rejects with 429 when the monthly usage limit is exceeded, before creating anything", async () => {
      contextModel.findOne.mockResolvedValue({ _id: "ctx1" });
      credentials.hasCredential.mockResolvedValue(true);
      agentRegistry.getForRole.mockReturnValue([
        {
          code: "DOCS_README",
          displayName: "",
          description: "",
          agent: "DOCS",
        },
      ]);
      usageLimit.checkAndIncrement.mockRejectedValue(
        Object.assign(new Error("limit exceeded"), {
          code: "USAGE_LIMIT_EXCEEDED",
        }),
      );

      await expect(
        service.createBatch(developer, {
          contextId: "ctx1",
          operations: ["DOCS_README"],
        }),
      ).rejects.toMatchObject({ code: "USAGE_LIMIT_EXCEEDED" });
      expect(taskModel.insertMany).not.toHaveBeenCalled();
      expect(queue.addBulk).not.toHaveBeenCalled();
    });
  });

  describe("findOneForUser", () => {
    it("throws NotFoundException when the task does not belong to the caller", async () => {
      taskModel.findOne.mockResolvedValue(null);

      await expect(service.findOneForUser("user1", "task1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("cancel", () => {
    it("throws NotFoundException when the task does not belong to the caller", async () => {
      taskModel.findOne.mockResolvedValue(null);

      await expect(service.cancel("user1", "task1")).rejects.toThrow(NotFoundException);
    });

    it("rejects with 409 when the task is already in a terminal state", async () => {
      taskModel.findOne.mockResolvedValue({
        status: "COMPLETED",
        canTransitionTo: vi.fn().mockReturnValue(false),
      });

      await expect(service.cancel("user1", "task1")).rejects.toThrow(ConflictException);
    });

    it("transitions to CANCELLED and emits task.updated", async () => {
      const task = {
        status: "PENDING",
        canTransitionTo: vi.fn().mockReturnValue(true),
        save: vi.fn().mockResolvedValue(undefined),
      };
      taskModel.findOne.mockResolvedValue(task);

      await service.cancel("user1", "task1");

      expect(task.status).toBe("CANCELLED");
      expect(task.save).toHaveBeenCalled();
      expect(events.emitTaskUpdated).toHaveBeenCalledWith("user1", "task1", "CANCELLED");
    });
  });
});

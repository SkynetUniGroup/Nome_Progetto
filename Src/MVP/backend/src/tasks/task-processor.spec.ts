import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { TaskProcessor } from "./task-processor";
import { Task } from "./schemas/task.schema";
import { EventsGateway } from "../events/events.gateway";
import { AgentInvocationService } from "./agent-invocation.service";

describe("TaskProcessor", () => {
  let processor: TaskProcessor;
  let taskModel: { findById: vi.fn; countDocuments: vi.fn };
  let events: {
    emitTaskUpdated: vi.fn;
    emitTaskFailed: vi.fn;
    emitBatchCompleted: vi.fn;
  };
  let agentInvocation: { invoke: vi.fn };

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "task1",
      userId: "user1",
      batchId: "batchA",
      status: "PENDING",
      error: null,
      reportId: null,
      canTransitionTo: vi.fn().mockReturnValue(true),
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(async () => {
    taskModel = { findById: vi.fn(), countDocuments: vi.fn() };
    events = {
      emitTaskUpdated: vi.fn(),
      emitTaskFailed: vi.fn(),
      emitBatchCompleted: vi.fn(),
    };
    agentInvocation = { invoke: vi.fn() };
    // No other task left active in the batch, by default — most tests only
    // care about the single task's own transition, not the batch tally.
    taskModel.countDocuments.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        { provide: getModelToken(Task.name), useValue: taskModel },
        { provide: EventsGateway, useValue: events },
        { provide: AgentInvocationService, useValue: agentInvocation },
      ],
    }).compile();

    processor = module.get(TaskProcessor);
  });

  function job(taskId = "task1") {
    return { data: { taskId } } as never;
  }

  it("does nothing if the Task no longer exists", async () => {
    taskModel.findById.mockResolvedValue(null);

    await processor.process(job());

    expect(events.emitTaskUpdated).not.toHaveBeenCalled();
  });

  it("skips a Task that was cancelled before the worker picked it up", async () => {
    const task = makeTask({
      status: "CANCELLED",
      canTransitionTo: vi.fn().mockReturnValue(false),
    });
    taskModel.findById.mockResolvedValue(task);

    await processor.process(job());

    expect(task.save).not.toHaveBeenCalled();
    expect(events.emitTaskUpdated).not.toHaveBeenCalled();
    expect(agentInvocation.invoke).not.toHaveBeenCalled();
  });

  it("transitions PENDING to RUNNING and emits task.updated before invoking the agent", async () => {
    const task = makeTask();
    taskModel.findById.mockResolvedValue(task);
    agentInvocation.invoke.mockResolvedValue({ status: "COMPLETED" });

    await processor.process(job());

    expect(events.emitTaskUpdated).toHaveBeenCalledWith("user1", "task1", "RUNNING");
  });

  it("marks the Task FAILED and emits task.failed when the invocation result says FAILED", async () => {
    const task = makeTask();
    taskModel.findById.mockResolvedValue(task);
    const error = {
      code: "UPSTREAM" as const,
      message: "boom",
      stage: "EXECUTION",
    };
    agentInvocation.invoke.mockResolvedValue({ status: "FAILED", error });

    await processor.process(job());

    expect(task.status).toBe("FAILED");
    expect(task.error).toEqual(error);
    expect(events.emitTaskFailed).toHaveBeenCalledWith("user1", "task1", error);
  });

  it("synthesizes a generic error if a FAILED result carries none", async () => {
    const task = makeTask();
    taskModel.findById.mockResolvedValue(task);
    agentInvocation.invoke.mockResolvedValue({ status: "FAILED" });

    await processor.process(job());

    expect(task.status).toBe("FAILED");
    expect(task.error).toMatchObject({ code: "UPSTREAM" });
  });

  it("marks the Task FAILED when the invocation throws, without letting the error escape", async () => {
    const task = makeTask();
    taskModel.findById.mockResolvedValue(task);
    agentInvocation.invoke.mockRejectedValue(new Error("network down"));

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(task.status).toBe("FAILED");
    expect(task.error).toMatchObject({
      code: "UPSTREAM",
      message: "network down",
    });
    expect(events.emitTaskFailed).toHaveBeenCalled();
  });

  it("does not emit batch.completed while sibling Tasks in the batch are still active", async () => {
    const task = makeTask();
    taskModel.findById.mockResolvedValue(task);
    agentInvocation.invoke.mockResolvedValue({ status: "FAILED", error: {} });
    taskModel.countDocuments.mockResolvedValueOnce(2); // still active

    await processor.process(job());

    expect(events.emitBatchCompleted).not.toHaveBeenCalled();
  });

  it("emits batch.completed with the tally once no sibling Task is still active", async () => {
    const task = makeTask();
    taskModel.findById.mockResolvedValue(task);
    agentInvocation.invoke.mockResolvedValue({ status: "COMPLETED" });
    taskModel.countDocuments
      .mockResolvedValueOnce(0) // none PENDING/RUNNING
      .mockResolvedValueOnce(3) // COMPLETED
      .mockResolvedValueOnce(1); // FAILED/CANCELLED

    await processor.process(job());

    expect(events.emitBatchCompleted).toHaveBeenCalledWith("user1", "batchA", 3, 1);
  });
});

import { AgentInvocationService } from "./agent-invocation.service";

interface MockTask {
  id: string;
  operation: string;
  lgThreadId?: string;
  save: vi.fn;
}

function makeTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: "task1",
    operation: "DOCS_README",
    lgThreadId: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("AgentInvocationService", () => {
  let service: AgentInvocationService;
  let config: { get: vi.fn };
  let agentRegistry: { getTimeoutS: vi.fn };
  let fetchMock: vi.fn;

  beforeEach(() => {
    config = { get: vi.fn().mockReturnValue("http://agents:8000") };
    agentRegistry = { getTimeoutS: vi.fn().mockReturnValue(90) };
    service = new AgentInvocationService(config as never, agentRegistry as never);
    fetchMock = vi.fn();
    global.fetch = fetchMock as never;
  });

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: () => Promise.resolve(body) };
  }

  it("generates and persists a threadId when the Task has none", async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: "completed" }));

    await service.invoke(task as never);

    expect(task.save).toHaveBeenCalled();
    expect(task.lgThreadId).toEqual(expect.any(String));
  });

  it("reuses an existing threadId without saving again", async () => {
    const task = makeTask({ lgThreadId: "existing-thread" });
    fetchMock.mockResolvedValue(jsonResponse({ status: "completed" }));

    await service.invoke(task as never);

    expect(task.save).not.toHaveBeenCalled();
    const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentBody = JSON.parse(options.body) as { threadId: string };
    expect(sentBody.threadId).toBe("existing-thread");
  });

  it("posts taskId, operationCode and an empty payload to /internal/agent/start", async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: "completed" }));

    await service.invoke(task as never);

    const [url, options] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("http://agents:8000/internal/agent/start");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toMatchObject({
      taskId: "task1",
      operationCode: "DOCS_README",
      payload: {},
    });
  });

  it("returns COMPLETED and drops the raw result on a completed response", async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: "completed", result: { diff: "..." } }));

    await expect(service.invoke(task as never)).resolves.toEqual({
      status: "COMPLETED",
    });
  });

  it("maps a failed response error through the agent error mapper", async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: "failed", error: "RATE_LIMITED" }));

    const result = await service.invoke(task as never);

    expect(result).toEqual({
      status: "FAILED",
      error: {
        code: "LLM_RATE_LIMITED",
        message: "RATE_LIMITED",
        stage: "EXECUTION",
      },
    });
  });

  it("treats an interrupted response as FAILED, pointing at BE-17", async () => {
    const task = makeTask({ operation: "CHANGELOG_TECHNICAL" });
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "interrupted",
        pendingInput: { kind: "SPRINT_ID" },
      }),
    );

    const result = await service.invoke(task as never);

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("BE-17");
  });

  it("fails with UPSTREAM on a non-2xx HTTP response", async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    const result = await service.invoke(task as never);

    expect(result.error?.code).toBe("UPSTREAM");
  });

  it("fails with UPSTREAM, not TIMEOUT, when the gateway aborts on its own deadline", async () => {
    // TIMEOUT is reserved for the agent itself reporting its model call
    // timed out — the gateway not getting a response at all is a distinct,
    // less specific failure (could be a hang, a crash, a network issue).
    const task = makeTask();
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeoutError);

    const result = await service.invoke(task as never);

    expect(result.error?.code).toBe("UPSTREAM");
  });

  it("fails with TIMEOUT when the agent itself reports its model call timed out", async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: "failed", error: "TIMEOUT" }));

    const result = await service.invoke(task as never);

    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("fails with UPSTREAM on a plain network error", async () => {
    const task = makeTask();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await service.invoke(task as never);

    expect(result.error).toMatchObject({
      code: "UPSTREAM",
      message: "ECONNREFUSED",
    });
  });
});

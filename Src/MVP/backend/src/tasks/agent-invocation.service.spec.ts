import { AgentInvocationService } from './agent-invocation.service';
import { AgentRunPayload } from './agent-client.types';

interface MockTask {
  id: string;
  operation: string;
  lgThreadId?: string;
  save: jest.Mock;
}

function makeTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task1',
    operation: 'DOCS_README',
    lgThreadId: undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('AgentInvocationService', () => {
  let service: AgentInvocationService;
  let config: { get: jest.Mock };
  let agentRegistry: { getTimeoutS: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    config = { get: jest.fn().mockReturnValue('http://agents:8000') };
    agentRegistry = { getTimeoutS: jest.fn().mockReturnValue(90) };
    service = new AgentInvocationService(
      config as never,
      agentRegistry as never,
    );
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: () => Promise.resolve(body) };
  }

  // BE-18: a 'completed' response always needs a `result` payload (the
  // service treats one without it as a failure — see the dedicated test
  // below) — this is the minimal valid one, for tests that only care about
  // something else.
  function completedResponse(result: AgentRunPayload = { body: [] }) {
    return jsonResponse({ status: 'completed', result });
  }

  it('generates and persists a threadId when the Task has none', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(completedResponse());

    await service.invoke(task as never);

    expect(task.save).toHaveBeenCalled();
    expect(task.lgThreadId).toEqual(expect.any(String));
  });

  it('reuses an existing threadId without saving again', async () => {
    const task = makeTask({ lgThreadId: 'existing-thread' });
    fetchMock.mockResolvedValue(completedResponse());

    await service.invoke(task as never);

    expect(task.save).not.toHaveBeenCalled();
    const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentBody = JSON.parse(options.body) as { threadId: string };
    expect(sentBody.threadId).toBe('existing-thread');
  });

  it('posts taskId, operationCode and an empty payload to /internal/agent/start', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(completedResponse());

    await service.invoke(task as never);

    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('http://agents:8000/internal/agent/start');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toMatchObject({
      taskId: 'task1',
      operationCode: 'DOCS_README',
      payload: {},
    });
  });

  it('returns COMPLETED carrying the agent result payload — BE-18 needs it to assemble a Report', async () => {
    const task = makeTask();
    const payload: AgentRunPayload = {
      body: [{ kind: 'TEXT', markdown: 'hello' }],
      summary: 'a summary',
      tokensConsumed: 42,
    };
    fetchMock.mockResolvedValue(completedResponse(payload));

    await expect(service.invoke(task as never)).resolves.toEqual({
      status: 'COMPLETED',
      payload,
    });
  });

  it('fails with PARSING when the agent reports completed without a result payload', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'completed' }));

    const result = await service.invoke(task as never);

    expect(result).toMatchObject({
      status: 'FAILED',
      error: { code: 'PARSING' },
    });
  });

  it('maps a failed response error through the agent error mapper', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 'failed', error: 'RATE_LIMITED' }),
    );

    const result = await service.invoke(task as never);

    expect(result).toEqual({
      status: 'FAILED',
      error: {
        code: 'LLM_RATE_LIMITED',
        message: 'RATE_LIMITED',
        stage: 'EXECUTION',
      },
    });
  });

  it('returns INTERRUPTED with the pendingInput the agent reported', async () => {
    const task = makeTask({ operation: 'CHANGELOG_TECHNICAL' });
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 'interrupted',
        pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['T-1'] },
      }),
    );

    const result = await service.invoke(task as never);

    expect(result).toEqual({
      status: 'INTERRUPTED',
      pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['T-1'] },
    });
  });

  it('fails with PARSING when the agent reports interrupted without a pendingInput', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'interrupted' }));

    const result = await service.invoke(task as never);

    expect(result).toMatchObject({
      status: 'FAILED',
      error: { code: 'PARSING' },
    });
  });

  it('fails with UPSTREAM on a non-2xx HTTP response', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    const result = await service.invoke(task as never);

    expect(result).toMatchObject({ error: { code: 'UPSTREAM' } });
  });

  it('fails with UPSTREAM, not TIMEOUT, when the gateway aborts on its own deadline', async () => {
    // TIMEOUT is reserved for the agent itself reporting its model call
    // timed out — the gateway not getting a response at all is a distinct,
    // less specific failure (could be a hang, a crash, a network issue).
    const task = makeTask();
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);

    const result = await service.invoke(task as never);

    expect(result).toMatchObject({ error: { code: 'UPSTREAM' } });
  });

  it('fails with TIMEOUT when the agent itself reports its model call timed out', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 'failed', error: 'TIMEOUT' }),
    );

    const result = await service.invoke(task as never);

    expect(result).toMatchObject({ error: { code: 'TIMEOUT' } });
  });

  it('fails with UPSTREAM on a plain network error', async () => {
    const task = makeTask();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.invoke(task as never);

    expect(result.error).toMatchObject({
      code: 'UPSTREAM',
      message: 'ECONNREFUSED',
    });
  });

  describe('resume', () => {
    it('posts taskId, threadId, operationCode and inputValue to /internal/agent/resume', async () => {
      const task = makeTask({
        operation: 'CHANGELOG_TECHNICAL',
        lgThreadId: 'existing-thread',
      });
      fetchMock.mockResolvedValue(completedResponse());

      await service.resume(task as never, { action: 'PROCEED' });

      const [url, options] = fetchMock.mock.calls[0] as [
        string,
        { method: string; body: string },
      ];
      expect(url).toBe('http://agents:8000/internal/agent/resume');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        taskId: 'task1',
        threadId: 'existing-thread',
        operationCode: 'CHANGELOG_TECHNICAL',
        inputValue: { action: 'PROCEED' },
      });
    });

    it('never generates a threadId — a resume with none is a caller bug, not started fresh', async () => {
      const task = makeTask({ lgThreadId: undefined });

      await expect(
        service.resume(task as never, { action: 'PROCEED' }),
      ).rejects.toThrow('no lgThreadId');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps a completed resume response the same way invoke() does, payload included', async () => {
      const task = makeTask({ lgThreadId: 'thread1' });
      const payload: AgentRunPayload = { body: [] };
      fetchMock.mockResolvedValue(completedResponse(payload));

      await expect(
        service.resume(task as never, { action: 'PROCEED' }),
      ).resolves.toEqual({ status: 'COMPLETED', payload });
    });

    it('can itself return INTERRUPTED again — BUSINESS_CONFIRMATION following INCOMPLETE_TASKS', async () => {
      const task = makeTask({ lgThreadId: 'thread1' });
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'interrupted',
          pendingInput: {
            kind: 'BUSINESS_CONFIRMATION',
            technicalReportId: 'report1',
          },
        }),
      );

      const result = await service.resume(task as never, {
        action: 'PROCEED',
      });

      expect(result).toEqual({
        status: 'INTERRUPTED',
        pendingInput: {
          kind: 'BUSINESS_CONFIRMATION',
          technicalReportId: 'report1',
        },
      });
    });
  });
});

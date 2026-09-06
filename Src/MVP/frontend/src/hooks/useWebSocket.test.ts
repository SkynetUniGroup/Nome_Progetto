import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAppStore } from "../stores/useAppStore";
/*
// --- Mock di socket.io-client -----------------------------------------
// Simuliamo un socket come un semplice event-emitter cosi' da poter
// scatenare a mano gli eventi ('connect', 'task.updated', ecc.) e verificare
// come l'hook reagisce, senza aprire nessuna connessione di rete reale.
class FakeSocket {
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  disconnect = vi.fn();

  on(event: string, handler: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler?: (...args: any[]) => void) {
    if (!this.handlers.has(event)) return;
    if (handler) this.handlers.get(event)!.delete(handler);
    else this.handlers.delete(event);
  }

  emit(event: string, payload?: any) {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

let lastSocket: FakeSocket | null = null;
const ioMock = vi.fn((..._args: any[]) => {
  lastSocket = new FakeSocket();
  return lastSocket;
});

vi.mock('socket.io-client', () => ({
  io: (...args: any[]) => ioMock(...args),
}));

const getReportMock = vi.fn();
const silentLoginStubMock = vi.fn();

vi.mock('../utils/api', () => ({
  getReport: (...args: any[]) => getReportMock(...args),
  silentLoginStub: (...args: any[]) => silentLoginStubMock(...args),
}));

const { useWebSocket } = await import('./useWebSocket');

const initialState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initialState, true);
  sessionStorage.clear();
  ioMock.mockClear();
  getReportMock.mockReset();
  silentLoginStubMock.mockReset();
  silentLoginStubMock.mockResolvedValue({ accessToken: 'jwt-xyz' });
  lastSocket = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('useWebSocket', () => {
  it('esegue il login silenzioso prima di connettersi se non c\'e\' ancora un token', async () => {
    renderHook(() => useWebSocket());

    await waitFor(() => expect(silentLoginStubMock).toHaveBeenCalledTimes(1));
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('non ripete il login silenzioso se un token e\' gia\' presente in sessionStorage', async () => {
    sessionStorage.setItem('jwt_token', 'jwt-gia-presente');

    renderHook(() => useWebSocket());

    await waitFor(() => expect(ioMock).toHaveBeenCalledTimes(1));
    expect(silentLoginStubMock).not.toHaveBeenCalled();
  });

  it('non tenta la connessione websocket se il login silenzioso fallisce', async () => {
    sessionStorage.clear();
    silentLoginStubMock.mockRejectedValueOnce(new Error('login fallito'));

    renderHook(() => useWebSocket());

    await waitFor(() => expect(silentLoginStubMock).toHaveBeenCalledTimes(1));
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('aggiorna websocketConnected a true/false sugli eventi connect/disconnect', async () => {
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => lastSocket!.emit('connect'));
    expect(useAppStore.getState().websocketConnected).toBe(true);

    act(() => lastSocket!.emit('disconnect'));
    expect(useAppStore.getState().websocketConnected).toBe(false);
  });

  it('task.progress porta la task in stato RUNNING', async () => {
    useAppStore.getState().addTask({ id: 'task-1', contextId: 'ctx', operation: 'SECURITY_OWASP', status: 'PENDING' });
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => lastSocket!.emit('task.progress', { taskId: 'task-1', progress: 40 }));

    expect(useAppStore.getState().tasks[0].status).toBe('RUNNING');
  });

  it('task.updated con status COMPLETED recupera e memorizza il report se non gia\' presente', async () => {
    useAppStore.getState().addTask({ id: 'task-1', contextId: 'ctx', operation: 'SECURITY_OWASP', status: 'RUNNING' });
    getReportMock.mockResolvedValueOnce({
      id: 'report-1', taskId: 'task-1', agentId: 'security', operation: 'SECURITY_OWASP',
      status: 'COMPLETED', body: [], generatedAt: '2026-01-01T00:00:00Z',
    });
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => lastSocket!.emit('task.updated', { taskId: 'task-1', status: 'COMPLETED', reportId: 'report-1' }));

    await waitFor(() => expect(useAppStore.getState().reports['report-1']).toBeDefined());
    expect(useAppStore.getState().tasks[0].status).toBe('COMPLETED');
    expect(useAppStore.getState().tasks[0].reportId).toBe('report-1');
    expect(getReportMock).toHaveBeenCalledWith('report-1');
  });

  it('task.updated con status COMPLETED NON ri-recupera un report gia\' presente in store (dedup)', async () => {
    useAppStore.getState().addTask({ id: 'task-1', contextId: 'ctx', operation: 'SECURITY_OWASP', status: 'RUNNING' });
    useAppStore.getState().addReport({
      id: 'report-1', taskId: 'task-1', agentId: 'security', operation: 'SECURITY_OWASP',
      status: 'COMPLETED', body: [], generatedAt: '2026-01-01T00:00:00Z', title: "title",
    });
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => lastSocket!.emit('task.updated', { taskId: 'task-1', status: 'COMPLETED', reportId: 'report-1' }));

    expect(getReportMock).not.toHaveBeenCalled();
  });

  it('task.updated con status COMPLETED logga l\'errore se il recupero del report fallisce', async () => {
    useAppStore.getState().addTask({ id: 'task-1', contextId: 'ctx', operation: 'SECURITY_OWASP', status: 'RUNNING' });
    getReportMock.mockRejectedValueOnce(new Error('report non trovato'));
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    await act(async () => {
      lastSocket!.emit('task.updated', { taskId: 'task-1', status: 'COMPLETED', reportId: 'report-1' });
      await Promise.resolve();
    });

    await waitFor(() => expect(console.error).toHaveBeenCalledWith('Errore nel recupero del report:', expect.any(Error)));
    // La task risulta comunque COMPLETED: solo il fetch del report e' fallito.
    expect(useAppStore.getState().tasks[0].status).toBe('COMPLETED');
    expect(useAppStore.getState().reports['report-1']).toBeUndefined();
  });

  it('batch.completed viene loggato senza alterare lo stato dello store', async () => {
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => lastSocket!.emit('batch.completed', { batchId: 'batch-1', completed: 2, failed: 1 }));

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('batch-1'));
  });

  it('task.failed porta la task in stato FAILED', async () => {
    useAppStore.getState().addTask({ id: 'task-1', contextId: 'ctx', operation: 'SECURITY_OWASP', status: 'RUNNING' });
    renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => lastSocket!.emit('task.failed', { taskId: 'task-1', error: { kind: 'TIMEOUT', message: 'timeout LLM', stage: 'invoca_llm' } }));

    expect(useAppStore.getState().tasks[0].status).toBe('FAILED');
  });

  it('allo smontaggio rimuove tutti i listener e disconnette il socket', async () => {
    const { unmount } = renderHook(() => useWebSocket());
    await waitFor(() => expect(lastSocket).not.toBeNull());
    const socket = lastSocket!;

    expect(socket.listenerCount('task.updated')).toBeGreaterThan(0);

    unmount();

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('task.progress')).toBe(0);
    expect(socket.listenerCount('task.updated')).toBe(0);
    expect(socket.listenerCount('task.failed')).toBe(0);
    expect(socket.listenerCount('batch.completed')).toBe(0);
  });
});
*/

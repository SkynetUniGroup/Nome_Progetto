import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSessionStore } from '../stores/sessionStore';
import { useTasksStore } from '../stores/tasksStore';

// --- Mock di socket.io-client -----------------------------------------
// Simuliamo il socket come un event-emitter cosi' da poter scatenare a mano
// gli eventi del server ('task.updated', 'task.failed', ...) e osservare come
// l'hook reagisce, senza aprire nessuna connessione di rete reale.
//
// Nota: `trigger` NON e' l'emit di socket.io (che manda al server, e che
// l'hook non usa mai): e' il verso opposto, cioe' il server che parla al
// client. Il nome diverso evita di confondere le due direzioni.
class FakeSocket {
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  private managerHandlers = new Map<string, Set<() => void>>();

  id = 'socket-fake';
  disconnect = vi.fn();

  /** Eventi del socket veri e propri (socket.on(...)). */
  on(event: string, handler: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler?: (...args: any[]) => void) {
    if (!this.handlers.has(event)) return;
    if (handler) this.handlers.get(event)!.delete(handler);
    else this.handlers.delete(event);
  }

  /**
   * Eventi del Manager (socket.io.on(...)), separati da quelli del socket:
   * 'reconnect' arriva da qui, non da socket.on.
   */
  io = {
    on: (event: string, handler: () => void) => {
      if (!this.managerHandlers.has(event)) this.managerHandlers.set(event, new Set());
      this.managerHandlers.get(event)!.add(handler);
    },
  };

  /** Simula un evento inviato dal server al client. */
  trigger(event: string, payload?: any) {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  /** Simula un evento del Manager (es. la riconnessione automatica). */
  triggerManager(event: string) {
    this.managerHandlers.get(event)?.forEach((h) => h());
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

const apiGetMock = vi.fn();

vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => apiGetMock(...args),
  },
}));

// L'import dell'hook e' dinamico e successivo ai vi.mock: un import statico
// verrebbe risolto prima che `ioMock` sia inizializzato, e la factory del mock
// leggerebbe una variabile ancora in temporal dead zone.
const { useWebSocket } = await import('./useWebSocket');

const initialSession = useSessionStore.getState();
const initialTasks = useTasksStore.getState();

const TOKEN = 'jwt-di-prova';

/** Task gia' nota allo store, punto di partenza di quasi tutti gli scenari. */
function seedTask(id = 'task-1') {
  useTasksStore.getState().loadTasks([
    {
      id,
      operation: 'SECURITY_OWASP',
      status: 'RUNNING',
      progressPercent: 10,
      currentStage: 'carica_contesto',
      reportId: null,
      error: null,
      pendingInput: null,
    },
  ]);
}

/** Monta l'hook con un utente gia' autenticato e attende la connessione. */
async function renderConnected() {
  useSessionStore.setState({ token: TOKEN });
  const rendered = renderHook(() => useWebSocket());
  await waitFor(() => expect(lastSocket).not.toBeNull());
  return rendered;
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  useTasksStore.setState(initialTasks, true);
  ioMock.mockClear();
  apiGetMock.mockReset();
  lastSocket = null;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('useWebSocket', () => {
  it('non apre nessuna connessione se l\'utente non e\' autenticato', () => {
    // Arrange: nessun token in sessione (stato iniziale dello store).
    // Act
    renderHook(() => useWebSocket());

    // Assert
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('apre una sola connessione passando il token nell\'handshake', async () => {
    useSessionStore.setState({ token: TOKEN });

    renderHook(() => useWebSocket());

    await waitFor(() => expect(ioMock).toHaveBeenCalledTimes(1));
    const [, options] = ioMock.mock.calls[0] as [string, any];
    expect(options.auth).toEqual({ token: TOKEN });
    expect(options.transports).toEqual(['websocket']);
  });

  it('task.updated aggiorna stato e reportId della task', async () => {
    seedTask();
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.updated', {
        taskId: 'task-1',
        status: 'COMPLETED',
        reportId: 'report-1',
      }),
    );

    const task = useTasksStore.getState().tasks['task-1'];
    expect(task.status).toBe('COMPLETED');
    expect(task.reportId).toBe('report-1');
  });

  it('task.updated crea la task se non e\' ancora nota allo store', async () => {
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.updated', { taskId: 'task-mai-vista', status: 'RUNNING' }),
    );

    expect(useTasksStore.getState().tasks['task-mai-vista']).toMatchObject({
      id: 'task-mai-vista',
      status: 'RUNNING',
    });
  });

  it('task.progress aggiorna stage e percentuale di avanzamento', async () => {
    seedTask();
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.progress', {
        taskId: 'task-1',
        stage: 'analisi_llm',
        percent: 65,
      }),
    );

    const task = useTasksStore.getState().tasks['task-1'];
    expect(task.currentStage).toBe('analisi_llm');
    expect(task.progressPercent).toBe(65);
  });

  it('task.failed porta la task in FAILED conservandone l\'errore', async () => {
    seedTask();
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.failed', {
        taskId: 'task-1',
        error: { code: 'TIMEOUT', message: 'timeout del modello', stage: 'invoca_llm' },
      }),
    );

    const task = useTasksStore.getState().tasks['task-1'];
    expect(task.status).toBe('FAILED');
    expect(task.error).toEqual({
      code: 'TIMEOUT',
      message: 'timeout del modello',
      stage: 'invoca_llm',
    });
  });

  it('task.failed con codice CREDENTIAL_INVALID marca le credenziali come non valide', async () => {
    seedTask();
    await renderConnected();
    expect(useSessionStore.getState().credentialsStatus).not.toBe('invalid');

    act(() =>
      lastSocket!.trigger('task.failed', {
        taskId: 'task-1',
        error: {
          code: 'CREDENTIAL_INVALID',
          message: 'token GitHub scaduto',
          stage: 'carica_contesto',
        },
      }),
    );

    expect(useSessionStore.getState().credentialsStatus).toBe('invalid');
  });

  it('task.failed con un altro codice non tocca lo stato delle credenziali', async () => {
    seedTask();
    useSessionStore.setState({ credentialsStatus: 'connected' });
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.failed', {
        taskId: 'task-1',
        error: { code: 'TIMEOUT', message: 'timeout del modello', stage: 'invoca_llm' },
      }),
    );

    expect(useSessionStore.getState().credentialsStatus).toBe('connected');
  });

  it('task.inputRequired di tipo SPRINT_ID espone la richiesta sulla task', async () => {
    seedTask();
    await renderConnected();

    act(() => lastSocket!.trigger('task.inputRequired', { taskId: 'task-1', kind: 'SPRINT_ID' }));

    expect(useTasksStore.getState().tasks['task-1'].pendingInput).toEqual({ kind: 'SPRINT_ID' });
  });

  it('task.inputRequired di tipo INCOMPLETE_TASKS conserva l\'elenco delle task incomplete', async () => {
    seedTask();
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.inputRequired', {
        taskId: 'task-1',
        kind: 'INCOMPLETE_TASKS',
        taskIds: ['ISSUE-4', 'ISSUE-9'],
      }),
    );

    expect(useTasksStore.getState().tasks['task-1'].pendingInput).toEqual({
      kind: 'INCOMPLETE_TASKS',
      taskIds: ['ISSUE-4', 'ISSUE-9'],
    });
  });

  it('task.inputRequired di tipo BUSINESS_CONFIRMATION conserva il report tecnico di riferimento', async () => {
    seedTask();
    await renderConnected();

    act(() =>
      lastSocket!.trigger('task.inputRequired', {
        taskId: 'task-1',
        kind: 'BUSINESS_CONFIRMATION',
        reportId: 'report-tecnico-1',
      }),
    );

    expect(useTasksStore.getState().tasks['task-1'].pendingInput).toEqual({
      kind: 'BUSINESS_CONFIRMATION',
      technicalReportId: 'report-tecnico-1',
    });
  });

  it('alla riconnessione risincronizza la lista delle task da GET /tasks', async () => {
    // Arrange: lo store ha uno stato ormai vecchio, il server ne ha uno nuovo.
    seedTask();
    apiGetMock.mockResolvedValueOnce({
      data: [
        {
          id: 'task-1',
          operation: 'SECURITY_OWASP',
          status: 'COMPLETED',
          progressPercent: 100,
          currentStage: 'fine',
          reportId: 'report-1',
          error: null,
        },
      ],
    });
    await renderConnected();

    // Act: Socket.IO non ripete gli eventi persi, quindi la riconnessione
    // deve rileggere lo stato dalle API.
    await act(async () => {
      lastSocket!.triggerManager('reconnect');
    });

    // Assert
    await waitFor(() => expect(useTasksStore.getState().tasks['task-1'].status).toBe('COMPLETED'));
    expect(apiGetMock).toHaveBeenCalledWith('/tasks');
    expect(useTasksStore.getState().tasks['task-1'].progressPercent).toBe(100);
  });

  it('se la risincronizzazione fallisce non propaga l\'errore e lascia lo stato precedente', async () => {
    seedTask();
    apiGetMock.mockRejectedValueOnce(new Error('backend irraggiungibile'));
    await renderConnected();

    await act(async () => {
      lastSocket!.triggerManager('reconnect');
    });

    // Lo stato resta quello vecchio: preferibile a un crash dell'interfaccia.
    expect(useTasksStore.getState().tasks['task-1'].status).toBe('RUNNING');
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
  });

  it('allo smontaggio chiude la connessione', async () => {
    const { unmount } = await renderConnected();
    const socket = lastSocket!;
    expect(socket.listenerCount('task.updated')).toBeGreaterThan(0);

    unmount();

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('al logout chiude la connessione e non ne apre una nuova', async () => {
    await renderConnected();
    const socket = lastSocket!;

    act(() => useSessionStore.getState().logout());

    await waitFor(() => expect(socket.disconnect).toHaveBeenCalledTimes(1));
    expect(ioMock).toHaveBeenCalledTimes(1);
  });
});

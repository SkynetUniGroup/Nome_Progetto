import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
/*import type { Task, Report } from '../types';

// Lo store e' un singleton globale (create() di zustand): resettiamo lo
// stato a quello iniziale prima di ogni test per evitare che i test si
// influenzino a vicenda tramite lo stato condiviso.
const initialState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initialState, true);
});

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  contextId: 'ctx-1',
  operation: 'SECURITY_OWASP',
  status: 'PENDING',
  ...overrides,
});

describe('useAppStore', () => {
  it('parte con lo stato iniziale atteso (isConfigured=false, collezioni vuote)', () => {
    const state = useAppStore.getState();
    expect(state.contexts).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.reports).toEqual({});
    expect(state.currentTaskId).toBeNull();
    expect(state.websocketConnected).toBe(false);
    expect(state.isConfigured).toBe(false);
    expect(state.formData).toBeNull();
  });

  it('addContext accoda un nuovo context senza mutare l\'array precedente', () => {
    const before = useAppStore.getState().contexts;
    useAppStore.getState().addContext({
      id: 'ctx-1',
      repoOwner: 'skynet',
      repoName: 'code_guardian',
      ref: 'main',
      scope: '',
    });
    const after = useAppStore.getState().contexts;

    expect(after).toHaveLength(1);
    expect(after).not.toBe(before); // nuovo riferimento (immutabilita')
    expect(after[0].repoName).toBe('code_guardian');
  });

  it('setTasks sostituisce interamente la lista delle task', () => {
    useAppStore.getState().addTask(makeTask({ id: 'stale' }));
    useAppStore.getState().setTasks([makeTask({ id: 'fresh' })]);

    const tasks = useAppStore.getState().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('fresh');
  });

  it('addTask accoda una nuova task preservando quelle esistenti', () => {
    useAppStore.getState().addTask(makeTask({ id: 'task-1' }));
    useAppStore.getState().addTask(makeTask({ id: 'task-2' }));

    const tasks = useAppStore.getState().tasks;
    expect(tasks.map((t) => t.id)).toEqual(['task-1', 'task-2']);
  });

  it('updateTask applica una patch parziale solo alla task con id corrispondente', () => {
    useAppStore.getState().addTask(makeTask({ id: 'task-1', status: 'PENDING' }));
    useAppStore.getState().addTask(makeTask({ id: 'task-2', status: 'PENDING' }));

    useAppStore.getState().updateTask('task-1', { status: 'COMPLETED', reportId: 'report-1' });

    const tasks = useAppStore.getState().tasks;
    const task1 = tasks.find((t) => t.id === 'task-1')!;
    const task2 = tasks.find((t) => t.id === 'task-2')!;

    expect(task1.status).toBe('COMPLETED');
    expect(task1.reportId).toBe('report-1');
    expect(task2.status).toBe('PENDING'); // non toccata
  });

  it('updateTask su un id inesistente non genera errori e lascia la lista invariata', () => {
    useAppStore.getState().addTask(makeTask({ id: 'task-1' }));

    expect(() => useAppStore.getState().updateTask('non-esiste', { status: 'FAILED' })).not.toThrow();
    expect(useAppStore.getState().tasks).toHaveLength(1);
    expect(useAppStore.getState().tasks[0].status).toBe('PENDING');
  });

  it('setCurrentTask imposta e resetta (null) l\'id corrente', () => {
    useAppStore.getState().setCurrentTask('task-1');
    expect(useAppStore.getState().currentTaskId).toBe('task-1');

    useAppStore.getState().setCurrentTask(null);
    expect(useAppStore.getState().currentTaskId).toBeNull();
  });

  it('addReport indicizza il report per id senza rimuovere i report gia\' presenti', () => {
    const reportA: Report = {
      id: 'report-a', taskId: 't', agentId: 'a', operation: 'SECURITY_OWASP',
      status: 'COMPLETED', body: [], generatedAt: '2026-01-01T00:00:00Z',
    };
    const reportB: Report = { ...reportA, id: 'report-b' };

    useAppStore.getState().addReport(reportA);
    useAppStore.getState().addReport(reportB);

    const reports = useAppStore.getState().reports;
    expect(Object.keys(reports)).toEqual(['report-a', 'report-b']);
  });

  it('addReport con stesso id sovrascrive il report precedente', () => {
    const v1: Report = {
      id: 'report-a', taskId: 't', agentId: 'a', operation: 'SECURITY_OWASP',
      status: 'RUNNING', body: [], generatedAt: '2026-01-01T00:00:00Z',
    };
    const v2: Report = { ...v1, status: 'COMPLETED' };

    useAppStore.getState().addReport(v1);
    useAppStore.getState().addReport(v2);

    expect(useAppStore.getState().reports['report-a'].status).toBe('COMPLETED');
  });

  it('setWebSocketConnected riflette lo stato della connessione', () => {
    useAppStore.getState().setWebSocketConnected(true);
    expect(useAppStore.getState().websocketConnected).toBe(true);

    useAppStore.getState().setWebSocketConnected(false);
    expect(useAppStore.getState().websocketConnected).toBe(false);
  });

  it('setConfigured abilita/disabilita il flag di configurazione iniziale', () => {
    useAppStore.getState().setConfigured(true);
    expect(useAppStore.getState().isConfigured).toBe(true);
  });

  it('setFormData memorizza i dati del form di selezione repository', () => {
    const data = { repoOwner: 'skynet', repoName: 'code_guardian', ref: 'main', scope: 'src/' };
    useAppStore.getState().setFormData(data);
    expect(useAppStore.getState().formData).toEqual(data);
  });
});
*/

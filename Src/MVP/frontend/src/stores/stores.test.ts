import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';
import { useSelectionStore } from './selectionStore';
import { useTasksStore } from './tasksStore';
import type { AnalysisContextDto, TaskEntry } from '../types';

const initialSession = useSessionStore.getState();
const initialSelection = useSelectionStore.getState();
const initialTasks = useTasksStore.getState();

const CONTESTO: AnalysisContextDto = {
  id: 'ctx-1',
  repoOwner: 'OWASP',
  repoName: 'NodeGoat',
  isPrivate: true,
  resolvedSha: 'abc1234',
  scopeType: 'FULL_REPOSITORY',
  paths: [],
  detectedLanguages: ['JavaScript'],
  estimatedFileCount: 42,
};

function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    operation: 'SECURITY_OWASP',
    status: 'RUNNING',
    progressPercent: 0,
    currentStage: null,
    reportId: null,
    error: null,
    pendingInput: null,
    ...over,
  };
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  useSelectionStore.setState(initialSelection, true);
  useTasksStore.setState(initialTasks, true);
});

describe('sessionStore', () => {
  it('parte da uno stato non autenticato', () => {
    const stato = useSessionStore.getState();

    expect(stato.isAuthenticated()).toBe(false);
    expect(stato.user).toBeNull();
    expect(stato.credentialsStatus).toBe('unknown');
  });

  it('dopo il login risulta autenticato e conserva l\'utente', () => {
    useSessionStore.getState().login({ id: 'u1', firstName: 'Ada', role: 'DEVELOPER' }, 'jwt');

    expect(useSessionStore.getState().isAuthenticated()).toBe(true);
    expect(useSessionStore.getState().user?.firstName).toBe('Ada');
  });

  it('il logout azzera utente, token e stato delle credenziali', () => {
    useSessionStore.getState().login({ id: 'u1', firstName: 'Ada', role: 'DEVELOPER' }, 'jwt');
    useSessionStore.getState().setCredentialsStatus('connected');

    useSessionStore.getState().logout();

    const stato = useSessionStore.getState();
    expect(stato.isAuthenticated()).toBe(false);
    expect(stato.user).toBeNull();
    expect(stato.credentialsStatus).toBe('unknown');
  });

  it('il token resta solo in memoria, mai nelle Web Storage', () => {
    // Requisito di sicurezza: il token deve sparire al refresh della pagina.
    useSessionStore.getState().login({ id: 'u1', firstName: 'Ada', role: 'DEVELOPER' }, 'jwt-segreto');

    expect(JSON.stringify(localStorage)).not.toContain('jwt-segreto');
    expect(JSON.stringify(sessionStorage)).not.toContain('jwt-segreto');
  });

  it('marcare le credenziali non valide non chiude la sessione', () => {
    useSessionStore.getState().login({ id: 'u1', firstName: 'Ada', role: 'DEVELOPER' }, 'jwt');

    useSessionStore.getState().markCredentialsInvalid();

    expect(useSessionStore.getState().credentialsStatus).toBe('invalid');
    expect(useSessionStore.getState().isAuthenticated()).toBe(true);
  });
});

describe('selectionStore', () => {
  it('memorizza contesto e relativo identificativo', () => {
    useSelectionStore.getState().setContext(CONTESTO);

    expect(useSelectionStore.getState().contextId).toBe('ctx-1');
    expect(useSelectionStore.getState().context).toEqual(CONTESTO);
  });

  it('azzerando la selezione non resta alcun riferimento al contesto', () => {
    useSelectionStore.getState().setContext(CONTESTO);

    useSelectionStore.getState().clearContext();

    expect(useSelectionStore.getState().contextId).toBeNull();
    expect(useSelectionStore.getState().context).toBeNull();
  });

  it('sostituire il contesto non lascia residui del precedente', () => {
    useSelectionStore.getState().setContext(CONTESTO);

    useSelectionStore.getState().setContext({ ...CONTESTO, id: 'ctx-2', repoName: 'Altro' });

    expect(useSelectionStore.getState().contextId).toBe('ctx-2');
    expect(useSelectionStore.getState().context?.repoName).toBe('Altro');
  });
});

describe('tasksStore', () => {
  it('loadTasks sostituisce l\'elenco invece di accodarlo', () => {
    useTasksStore.getState().loadTasks([task({ id: 'vecchia' })]);

    useTasksStore.getState().loadTasks([task({ id: 'nuova' })]);

    expect(Object.keys(useTasksStore.getState().tasks)).toEqual(['nuova']);
  });

  it('un evento di avanzamento su una task sconosciuta la crea comunque', () => {
    // Puo' succedere se la task e' stata avviata da un'altra sessione.
    useTasksStore.getState().upsertFromProgress({ taskId: 'ignota', stage: 'analisi', percent: 30 });

    expect(useTasksStore.getState().tasks.ignota).toMatchObject({
      id: 'ignota',
      currentStage: 'analisi',
      progressPercent: 30,
    });
  });

  it('un aggiornamento senza reportId non cancella quello gia\' noto', () => {
    useTasksStore.getState().loadTasks([task({ id: 't1', reportId: 'rep-1' })]);

    useTasksStore.getState().upsertFromUpdated({ taskId: 't1', status: 'COMPLETED' });

    expect(useTasksStore.getState().tasks.t1.reportId).toBe('rep-1');
  });

  it('un fallimento su una task sconosciuta la crea in stato FAILED', () => {
    useTasksStore.getState().applyFailed({
      taskId: 'ignota',
      error: { code: 'TIMEOUT', message: 'scaduto', stage: 'invoca_llm' },
    });

    expect(useTasksStore.getState().tasks.ignota.status).toBe('FAILED');
  });

  it('una richiesta di input su una task sconosciuta la crea in attesa', () => {
    useTasksStore.getState().applyInputRequired({ taskId: 'ignota', kind: 'SPRINT_ID' });

    expect(useTasksStore.getState().tasks.ignota.pendingInput).toEqual({ kind: 'SPRINT_ID' });
  });

  it('una richiesta INCOMPLETE_TASKS senza elenco produce comunque una lista vuota', () => {
    useTasksStore.getState().applyInputRequired({ taskId: 't1', kind: 'INCOMPLETE_TASKS' });

    expect(useTasksStore.getState().tasks.t1.pendingInput).toEqual({
      kind: 'INCOMPLETE_TASKS',
      taskIds: [],
    });
  });

  it('una richiesta BUSINESS_CONFIRMATION senza report produce una stringa vuota', () => {
    useTasksStore.getState().applyInputRequired({ taskId: 't1', kind: 'BUSINESS_CONFIRMATION' });

    expect(useTasksStore.getState().tasks.t1.pendingInput).toEqual({
      kind: 'BUSINESS_CONFIRMATION',
      technicalReportId: '',
    });
  });

  it('evadere la richiesta di input azzera solo quel campo', () => {
    useTasksStore.getState().loadTasks([
      task({ id: 't1', status: 'RUNNING', pendingInput: { kind: 'SPRINT_ID' } }),
    ]);

    useTasksStore.getState().clearPendingInput('t1');

    expect(useTasksStore.getState().tasks.t1.pendingInput).toBeNull();
    expect(useTasksStore.getState().tasks.t1.status).toBe('RUNNING');
  });

  it('evadere una richiesta su una task inesistente non crea nulla', () => {
    useTasksStore.getState().clearPendingInput('mai-vista');

    expect(useTasksStore.getState().tasks).toEqual({});
  });

  it('annullare una task ne cambia lo stato', () => {
    useTasksStore.getState().loadTasks([task({ id: 't1' })]);

    useTasksStore.getState().cancel('t1');

    expect(useTasksStore.getState().tasks.t1.status).toBe('CANCELLED');
  });

  it('annullare una task inesistente non ne fabbrica una', () => {
    useTasksStore.getState().cancel('mai-vista');

    expect(useTasksStore.getState().tasks).toEqual({});
  });
});

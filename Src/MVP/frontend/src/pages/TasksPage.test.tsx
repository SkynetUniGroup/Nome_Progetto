import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTasksStore } from '../stores/tasksStore';
import type { TaskEntry, TaskStatus } from '../types';

vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    // Il Link di TanStack costruisce l'URL da `to` + `params`: qui lo
    // ricomponiamo a mano cosi' da poter verificare la destinazione.
    Link: ({ to, params, children, ...rest }: any) => {
      const href = params
        ? Object.entries(params).reduce<string>(
            (acc, [k, v]) => acc.replace(`$${k}`, String(v)),
            to,
          )
        : to;
      return createElement('a', { href, ...rest }, children);
    },
  };
});

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => getMock(...args),
    post: (...args: any[]) => postMock(...args),
  },
}));

const { TasksPage } = await import('./TasksPage');

const initialTasks = useTasksStore.getState();

/** Costruisce una task completa a partire dalle sole differenze rilevanti. */
function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    operation: 'SECURITY_OWASP',
    status: 'PENDING',
    progressPercent: 0,
    currentStage: null,
    reportId: null,
    error: null,
    pendingInput: null,
    ...over,
  };
}

/** Monta la pagina attendendo la fine del caricamento iniziale. */
async function renderConTask(tasks: TaskEntry[]) {
  getMock.mockResolvedValueOnce({ data: [] });
  render(<TasksPage />);
  await screen.findByRole('heading', { name: 'Task' });
  // Le task arrivano dal WebSocket: le iniettiamo dopo il caricamento, come
  // farebbe l'hook, invece di passare dalla risposta REST.
  act(() => useTasksStore.getState().loadTasks(tasks));
  return userEvent.setup();
}

beforeEach(() => {
  useTasksStore.setState(initialTasks, true);
  getMock.mockReset();
  postMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('TasksPage', () => {
  it('al montaggio recupera l\'elenco delle task dal server', async () => {
    getMock.mockResolvedValueOnce({
      data: [{ id: 't1', operation: 'DOCS_README', status: 'COMPLETED' }],
    });

    render(<TasksPage />);

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/tasks'));
    expect(await screen.findByText('Documentazione README')).toBeInTheDocument();
  });

  it('applica valori di default ai campi che il server non valorizza', async () => {
    getMock.mockResolvedValueOnce({
      data: [{ id: 't1', operation: 'DOCS_README', status: 'RUNNING' }],
    });

    render(<TasksPage />);

    await waitFor(() => expect(useTasksStore.getState().tasks.t1).toBeDefined());
    expect(useTasksStore.getState().tasks.t1).toMatchObject({
      progressPercent: 0,
      currentStage: null,
      reportId: null,
    });
  });

  it('se il caricamento iniziale fallisce mostra comunque la pagina', async () => {
    getMock.mockRejectedValueOnce(new Error('rete assente'));

    render(<TasksPage />);

    // Non e' un errore fatale: il WebSocket continuera' ad aggiornare la lista.
    expect(await screen.findByRole('heading', { name: 'Task' })).toBeInTheDocument();
  });

  it('senza task invita ad avviarne una', async () => {
    await renderConTask([]);

    expect(await screen.findByText(/Nessun task trovato/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Avvia un'operazione/ })).toHaveAttribute(
      'href',
      '/run',
    );
  });

  it('mostra nome dell\'operazione e identificativo di ogni task', async () => {
    await renderConTask([task({ id: 'task-abc', operation: 'CHANGELOG_TECHNICAL' })]);

    expect(await screen.findByText('Changelog Tecnico')).toBeInTheDocument();
    expect(screen.getByText('task-abc')).toBeInTheDocument();
  });

  const STATI: [TaskStatus, string][] = [
    ['PENDING', 'In attesa'],
    ['RUNNING', 'In esecuzione'],
    ['COMPLETED', 'Completato'],
    ['FAILED', 'Fallito'],
    ['CANCELLED', 'Annullato'],
  ];

  it.each(STATI)('mostra l\'indicatore di stato per %s', async (status, etichetta) => {
    await renderConTask([task({ id: 't1', status })]);

    expect(await screen.findByText(etichetta)).toBeInTheDocument();
  });

  it('per una task in esecuzione mostra avanzamento e fase corrente', async () => {
    await renderConTask([
      task({ id: 't1', status: 'RUNNING', progressPercent: 65, currentStage: 'analisi_llm' }),
    ]);

    const barra = await screen.findByRole('progressbar');
    expect(barra).toHaveAttribute('aria-valuenow', '65');
    expect(screen.getByText('analisi_llm')).toBeInTheDocument();
  });

  it('non mostra la barra di avanzamento per una task non in esecuzione', async () => {
    await renderConTask([task({ id: 't1', status: 'COMPLETED', progressPercent: 100 })]);

    await screen.findByText('Completato');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('per una task fallita riporta codice, messaggio e fase dell\'errore', async () => {
    await renderConTask([
      task({
        id: 't1',
        status: 'FAILED',
        error: { code: 'TIMEOUT', message: 'il modello non ha risposto', stage: 'invoca_llm' },
      }),
    ]);

    expect(await screen.findByText(/TIMEOUT/)).toBeInTheDocument();
    expect(screen.getByText(/il modello non ha risposto/)).toBeInTheDocument();
    expect(screen.getByText(/fase: invoca_llm/)).toBeInTheDocument();
  });

  it('abilita il collegamento al report solo quando la task e\' completata', async () => {
    await renderConTask([
      task({ id: 't-ok', status: 'COMPLETED', reportId: 'rep-1' }),
      task({ id: 't-run', status: 'RUNNING', reportId: 'rep-2' }),
    ]);

    const collegamenti = await screen.findAllByRole('link', { name: 'Vedi report' });
    expect(collegamenti).toHaveLength(1);
    expect(collegamenti[0]).toHaveAttribute('href', '/reports/rep-1');
  });

  it('non mostra il collegamento se la task e\' completata ma priva di report', async () => {
    await renderConTask([task({ id: 't1', status: 'COMPLETED', reportId: null })]);

    await screen.findByText('Completato');
    expect(screen.queryByRole('link', { name: 'Vedi report' })).not.toBeInTheDocument();
  });

  it('consente di annullare solo le task ancora in attesa o in esecuzione', async () => {
    await renderConTask([
      task({ id: 't-pend', status: 'PENDING' }),
      task({ id: 't-run', status: 'RUNNING' }),
      task({ id: 't-done', status: 'COMPLETED' }),
      task({ id: 't-fail', status: 'FAILED' }),
    ]);

    const annulla = await screen.findAllByRole('button', { name: /Annulla/ });
    expect(annulla).toHaveLength(2);
  });

  it('annullando una task lo comunica al server e ne aggiorna subito lo stato', async () => {
    const user = await renderConTask([task({ id: 't1', status: 'RUNNING' })]);
    postMock.mockResolvedValueOnce({ data: {} });

    await user.click(await screen.findByRole('button', { name: /Annulla/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/tasks/t1/cancel'));
    expect(useTasksStore.getState().tasks.t1.status).toBe('CANCELLED');
  });

  it('se l\'annullamento fallisce non altera lo stato locale della task', async () => {
    const user = await renderConTask([task({ id: 't1', status: 'RUNNING' })]);
    postMock.mockRejectedValueOnce(new Error('500'));

    await user.click(await screen.findByRole('button', { name: /Annulla/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(useTasksStore.getState().tasks.t1.status).toBe('RUNNING');
  });

  it('ordina le task mettendo per prime quelle attive', async () => {
    await renderConTask([
      task({ id: 't-done', status: 'COMPLETED', operation: 'DOCS_API' }),
      task({ id: 't-run', status: 'RUNNING', operation: 'DOCS_README' }),
      task({ id: 't-pend', status: 'PENDING', operation: 'DOCS_INLINE' }),
    ]);

    const voci = await screen.findAllByRole('listitem');
    expect(within(voci[0]).getByText('Documentazione README')).toBeInTheDocument();
    expect(within(voci[1]).getByText('Documentazione Inline')).toBeInTheDocument();
    expect(within(voci[2]).getByText('Documentazione API')).toBeInTheDocument();
  });

  it('per una task in attesa di Sprint ID apre il modulo di inserimento e lo invia', async () => {
    const user = await renderConTask([
      task({ id: 't1', status: 'RUNNING', pendingInput: { kind: 'SPRINT_ID' } }),
    ]);
    postMock.mockResolvedValueOnce({ data: {} });

    await user.click(await screen.findByRole('button', { name: 'Inserisci Sprint ID' }));
    const modale = screen.getByRole('dialog');
    await user.type(within(modale).getByLabelText('Sprint ID'), 'SPRINT-42');
    await user.click(within(modale).getByRole('button', { name: 'Conferma' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/t1/input', {
        kind: 'SPRINT_ID',
        sprintId: 'SPRINT-42',
      }),
    );
    // Richiesta soddisfatta: il pulsante non deve piu' comparire.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useTasksStore.getState().tasks.t1.pendingInput).toBeNull();
  });

  it('per una task con task incompleti apre il modulo passando gli identificativi', async () => {
    const user = await renderConTask([
      task({
        id: 't1',
        status: 'RUNNING',
        pendingInput: { kind: 'INCOMPLETE_TASKS', taskIds: ['ISSUE-4', 'ISSUE-9'] },
      }),
    ]);

    await user.click(await screen.findByRole('button', { name: /Task incompleti/ }));

    const modale = screen.getByRole('dialog');
    expect(within(modale).getByText(/ISSUE-4/)).toBeInTheDocument();
    expect(within(modale).getByText(/ISSUE-9/)).toBeInTheDocument();
  });

  it('per una task in attesa di conferma apre il modulo di approvazione', async () => {
    const user = await renderConTask([
      task({
        id: 't1',
        status: 'RUNNING',
        pendingInput: { kind: 'BUSINESS_CONFIRMATION', technicalReportId: 'rep-tec-1' },
      }),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Conferma apertura PR' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('una task senza richieste pendenti non mostra alcun pulsante di intervento', async () => {
    await renderConTask([task({ id: 't1', status: 'RUNNING' })]);

    await screen.findByText('In esecuzione');
    expect(screen.queryByRole('button', { name: /Sprint ID/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task incompleti/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Conferma apertura/ })).not.toBeInTheDocument();
  });
});

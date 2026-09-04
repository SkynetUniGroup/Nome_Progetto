import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTasksStore } from '../../stores/tasksStore';
import type { TaskEntry } from '../../types';

const postMock = vi.fn();
vi.mock('../../api/client', () => ({
  apiClient: {
    post: (...args: any[]) => postMock(...args),
  },
}));

const { SprintIdModal } = await import('./SprintIdModal');
const { IncompleteTasksModal } = await import('./IncompleteTasksModal');
const { BusinessConfirmationModal } = await import('./BusinessConfirmationModal');
const { ModalOverlay } = await import('./ModalOverlay');

const initialTasks = useTasksStore.getState();

/** Task in pausa, in attesa di un intervento dell'utente. */
function taskInPausa(pendingInput: TaskEntry['pendingInput']) {
  useTasksStore.getState().loadTasks([
    {
      id: 't1',
      operation: 'CHANGELOG_TECHNICAL',
      status: 'RUNNING',
      progressPercent: 50,
      currentStage: 'attesa_input',
      reportId: null,
      error: null,
      pendingInput,
    },
  ]);
}

beforeEach(() => {
  useTasksStore.setState(initialTasks, true);
  postMock.mockReset();
});

describe('ModalOverlay', () => {
  it('non renderizza nulla quando e\' chiuso', () => {
    render(
      <ModalOverlay open={false} title="Titolo" onClose={vi.fn()}>
        <p>contenuto</p>
      </ModalOverlay>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('espone titolo e contenuto come finestra di dialogo accessibile', () => {
    render(
      <ModalOverlay open title="Titolo della finestra" onClose={vi.fn()}>
        <p>contenuto</p>
      </ModalOverlay>,
    );

    const dialogo = screen.getByRole('dialog');
    expect(dialogo).toHaveAttribute('aria-modal', 'true');
    expect(dialogo).toHaveAttribute('aria-label', 'Titolo della finestra');
    expect(screen.getByText('contenuto')).toBeInTheDocument();
  });

  it('si chiude premendo Escape', async () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay open title="Titolo" onClose={onClose}>
        <p>contenuto</p>
      </ModalOverlay>,
    );
    const user = userEvent.setup();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('non reagisce a Escape quando e\' chiuso', async () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay open={false} title="Titolo" onClose={onClose}>
        <p>contenuto</p>
      </ModalOverlay>,
    );
    const user = userEvent.setup();

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('si chiude cliccando sullo sfondo', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ModalOverlay open title="Titolo" onClose={onClose}>
        <p>contenuto</p>
      </ModalOverlay>,
    );
    const user = userEvent.setup();

    await user.click(container.querySelector('[aria-hidden="true"]')!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SprintIdModal', () => {
  it('non invia finche\' il campo e\' vuoto', () => {
    taskInPausa({ kind: 'SPRINT_ID' });
    render(<SprintIdModal taskId="t1" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Conferma' })).toBeDisabled();
  });

  it('non accetta un valore fatto di soli spazi', async () => {
    taskInPausa({ kind: 'SPRINT_ID' });
    render(<SprintIdModal taskId="t1" onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Sprint ID'), '   ');

    // Il pulsante resta disabilitato: l'invio non parte proprio, quindi la
    // richiesta non raggiunge mai il server.
    expect(screen.getByRole('button', { name: 'Conferma' })).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('ripulisce lo Sprint ID dagli spazi prima di inviarlo', async () => {
    taskInPausa({ kind: 'SPRINT_ID' });
    postMock.mockResolvedValueOnce({ data: {} });
    render(<SprintIdModal taskId="t1" onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Sprint ID'), '  SPRINT-42  ');
    await user.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/t1/input', {
        kind: 'SPRINT_ID',
        sprintId: 'SPRINT-42',
      }),
    );
  });

  it('se l\'invio fallisce lo segnala e non considera evasa la richiesta', async () => {
    taskInPausa({ kind: 'SPRINT_ID' });
    postMock.mockRejectedValueOnce(new Error('500'));
    const onClose = vi.fn();
    render(<SprintIdModal taskId="t1" onClose={onClose} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Sprint ID'), 'SPRINT-42');
    await user.click(screen.getByRole('button', { name: 'Conferma' }));

    expect(await screen.findByText(/Impossibile inviare l'ID Sprint/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(useTasksStore.getState().tasks.t1.pendingInput).not.toBeNull();
  });

  it('chiude senza inviare nulla se l\'utente annulla', async () => {
    taskInPausa({ kind: 'SPRINT_ID' });
    const onClose = vi.fn();
    render(<SprintIdModal taskId="t1" onClose={onClose} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('IncompleteTasksModal', () => {
  const IDS = ['ISSUE-4', 'ISSUE-9'];

  it('elenca i task ancora aperti trovati dall\'agente', () => {
    taskInPausa({ kind: 'INCOMPLETE_TASKS', taskIds: IDS });
    render(<IncompleteTasksModal taskId="t1" taskIds={IDS} onClose={vi.fn()} />);

    expect(screen.getByText('ISSUE-4')).toBeInTheDocument();
    expect(screen.getByText('ISSUE-9')).toBeInTheDocument();
  });

  it('procedendo comunque comunica la decisione e sblocca la task', async () => {
    taskInPausa({ kind: 'INCOMPLETE_TASKS', taskIds: IDS });
    postMock.mockResolvedValueOnce({ data: {} });
    const onClose = vi.fn();
    render(<IncompleteTasksModal taskId="t1" taskIds={IDS} onClose={onClose} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Procedi comunque/ }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/t1/input', {
        kind: 'INCOMPLETE_TASKS',
        action: 'PROCEED',
      }),
    );
    expect(useTasksStore.getState().tasks.t1.pendingInput).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('annullando l\'operazione invia la decisione opposta', async () => {
    taskInPausa({ kind: 'INCOMPLETE_TASKS', taskIds: IDS });
    postMock.mockResolvedValueOnce({ data: {} });
    render(<IncompleteTasksModal taskId="t1" taskIds={IDS} onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Annulla operazione' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/t1/input', {
        kind: 'INCOMPLETE_TASKS',
        action: 'CANCEL',
      }),
    );
  });

  it('se l\'invio fallisce lo segnala e lascia la task in attesa', async () => {
    taskInPausa({ kind: 'INCOMPLETE_TASKS', taskIds: IDS });
    postMock.mockRejectedValueOnce(new Error('500'));
    const onClose = vi.fn();
    render(<IncompleteTasksModal taskId="t1" taskIds={IDS} onClose={onClose} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Procedi comunque/ }));

    expect(await screen.findByText(/Impossibile inviare la risposta/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(useTasksStore.getState().tasks.t1.pendingInput).not.toBeNull();
  });
});

describe('BusinessConfirmationModal', () => {
  it('offre il report tecnico da consultare prima di decidere', () => {
    taskInPausa({ kind: 'BUSINESS_CONFIRMATION', technicalReportId: 'rep-tec-1' });
    render(
      <BusinessConfirmationModal taskId="t1" technicalReportId="rep-tec-1" onClose={vi.fn()} />,
    );

    const collegamento = screen.getByRole('link', { name: /Visualizza/ });
    expect(collegamento).toHaveAttribute('href', '/reports/rep-tec-1');
    // Si apre in una scheda nuova: la decisione in sospeso non va persa.
    expect(collegamento).toHaveAttribute('target', '_blank');
  });

  it('confermando chiede l\'apertura della Pull Request', async () => {
    taskInPausa({ kind: 'BUSINESS_CONFIRMATION', technicalReportId: 'rep-tec-1' });
    postMock.mockResolvedValueOnce({ data: {} });
    render(
      <BusinessConfirmationModal taskId="t1" technicalReportId="rep-tec-1" onClose={vi.fn()} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Apri Pull Request/ }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/t1/input', {
        kind: 'BUSINESS_CONFIRMATION',
        action: 'PROCEED',
      }),
    );
    expect(useTasksStore.getState().tasks.t1.pendingInput).toBeNull();
  });

  it('rifiutando invia la decisione di annullamento', async () => {
    taskInPausa({ kind: 'BUSINESS_CONFIRMATION', technicalReportId: 'rep-tec-1' });
    postMock.mockResolvedValueOnce({ data: {} });
    render(
      <BusinessConfirmationModal taskId="t1" technicalReportId="rep-tec-1" onClose={vi.fn()} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/t1/input', {
        kind: 'BUSINESS_CONFIRMATION',
        action: 'CANCEL',
      }),
    );
  });

  it('se l\'invio fallisce non apre la PR e lo dichiara', async () => {
    taskInPausa({ kind: 'BUSINESS_CONFIRMATION', technicalReportId: 'rep-tec-1' });
    postMock.mockRejectedValueOnce(new Error('500'));
    const onClose = vi.fn();
    render(
      <BusinessConfirmationModal taskId="t1" technicalReportId="rep-tec-1" onClose={onClose} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Apri Pull Request/ }));

    expect(await screen.findByText(/Impossibile inviare la risposta/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

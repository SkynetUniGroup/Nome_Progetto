import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from '../stores/useAppStore';
import type { StoredTask } from '../stores/useAppStore';

let currentTaskId = 'task-1';
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ taskId: currentTaskId }),
  // Link reso come una semplice <a>: basta per verificare href/testo, senza
  // bisogno di un router reale.
  Link: ({ to, params, children, ...rest }: any) => (
    <a href={to?.replace(/\$(\w+)/g, (_: string, name: string) => params?.[name] ?? '')} {...rest}>
      {children}
    </a>
  ),
}));

const { default: TaskExecution } = await import('./TaskExecution');

const initialState = useAppStore.getState();

const makeTask = (overrides: Partial<StoredTask> = {}): StoredTask => ({
  id: 'task-1',
  contextId: 'ctx-1',
  operation: 'SECURITY_OWASP',
  status: 'PENDING',
  ...overrides,
});

beforeEach(() => {
  useAppStore.setState(initialState, true);
  currentTaskId = 'task-1';
});

describe('TaskExecution', () => {
  it('mostra "Task non trovata" se l\'id in URL non corrisponde a nessuna task nello store', () => {
    currentTaskId = 'task-inesistente';
    render(<TaskExecution />);
    expect(screen.getByText(/Task non trovata/)).toBeInTheDocument();
  });

  it('imposta la task corrente nello store in base al parametro di rotta', () => {
    useAppStore.getState().addTask(makeTask());
    render(<TaskExecution />);
    expect(useAppStore.getState().currentTaskId).toBe('task-1');
  });

  it.each(['PENDING', 'RUNNING'] as const)('mostra la barra di avanzamento per lo stato %s', (status) => {
    useAppStore.getState().addTask(makeTask({ status }));
    render(<TaskExecution />);
    expect(screen.getByText(/Analisi in corso/)).toBeInTheDocument();
  });

  it('con stato COMPLETED e reportId mostra il link "Visualizza Report" verso il report', () => {
    useAppStore.getState().addTask(makeTask({ status: 'COMPLETED', reportId: 'report-42' }));
    render(<TaskExecution />);

    const link = screen.getByRole('link', { name: /Visualizza Report/i });
    expect(link).toHaveAttribute('href', '/reports/report-42');
  });

  it('con stato COMPLETED ma SENZA reportId non mostra il link al report (dato incoerente difensivo)', () => {
    useAppStore.getState().addTask(makeTask({ status: 'COMPLETED', reportId: undefined }));
    render(<TaskExecution />);
    expect(screen.queryByRole('link', { name: /Visualizza Report/i })).not.toBeInTheDocument();
  });

  it('con stato FAILED mostra il messaggio di fallimento e il link per tornare alla selezione', () => {
    useAppStore.getState().addTask(makeTask({ status: 'FAILED' }));
    render(<TaskExecution />);

    expect(screen.getByText(/Analisi fallita/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Torna alla selezione/i })).toHaveAttribute('href', '/');
  });

  it('con stato CANCELLED non mostra ne\' la progress bar ne\' i blocchi di completamento/fallimento', () => {
    useAppStore.getState().addTask(makeTask({ status: 'CANCELLED' }));
    render(<TaskExecution />);

    expect(screen.queryByText(/Analisi in corso/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Analisi completata/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Analisi fallita/)).not.toBeInTheDocument();
    expect(screen.getByText(/Stato: CANCELLED/)).toBeInTheDocument();
  });
});

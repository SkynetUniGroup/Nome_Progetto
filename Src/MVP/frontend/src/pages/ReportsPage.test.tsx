import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
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
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => getMock(...args),
  },
}));

const { ReportsPage } = await import('./ReportsPage');

/** Voce dello storico nella forma restituita da GET /reports. */
function riepilogo(over: Partial<Record<string, unknown>> & { id: string }) {
  return {
    taskId: 'task-1',
    operation: 'SECURITY_OWASP',
    status: 'COMPLETED',
    generatedAt: '2026-08-20T10:30:00Z',
    title: 'Analisi OWASP – OWASP/NodeGoat',
    durationMs: 12500,
    ...over,
  };
}

/** Monta la pagina attendendo la fine del caricamento. */
async function renderConReport(reports: unknown[]) {
  getMock.mockResolvedValueOnce({ data: reports });
  render(<ReportsPage />);
  await screen.findByRole('heading', { name: 'Storico Report' });
}

beforeEach(() => {
  getMock.mockReset();
});

describe('ReportsPage', () => {
  it('mostra uno stato di caricamento finche\' lo storico non e\' arrivato', () => {
    getMock.mockReturnValueOnce(new Promise(() => {}));

    render(<ReportsPage />);

    expect(screen.getByText(/Caricamento report/)).toBeInTheDocument();
  });

  it('richiede lo storico al server una sola volta', async () => {
    await renderConReport([]);

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('/reports');
  });

  it('elenca i report con titolo, operazione, stato, data e durata', async () => {
    await renderConReport([riepilogo({ id: 'rep-1' })]);

    const riga = screen.getAllByRole('row')[1];
    expect(within(riga).getByText('Analisi OWASP – OWASP/NodeGoat')).toBeInTheDocument();
    expect(within(riga).getByText('Analisi Sicurezza OWASP')).toBeInTheDocument();
    expect(within(riga).getByText('Completato')).toBeInTheDocument();
    expect(within(riga).getByText('12.5s')).toBeInTheDocument();
    expect(within(riga).getByText(/20\/08\/2026/)).toBeInTheDocument();
  });

  it('ordina i report dal piu\' recente al meno recente', async () => {
    await renderConReport([
      riepilogo({ id: 'vecchio', title: 'Report vecchio', generatedAt: '2026-08-01T08:00:00Z' }),
      riepilogo({ id: 'nuovo', title: 'Report nuovo', generatedAt: '2026-08-25T08:00:00Z' }),
      riepilogo({ id: 'medio', title: 'Report medio', generatedAt: '2026-08-10T08:00:00Z' }),
    ]);

    const righe = screen.getAllByRole('row').slice(1);
    expect(within(righe[0]).getByText('Report nuovo')).toBeInTheDocument();
    expect(within(righe[1]).getByText('Report medio')).toBeInTheDocument();
    expect(within(righe[2]).getByText('Report vecchio')).toBeInTheDocument();
  });

  it('mostra un trattino quando la durata non e\' disponibile', async () => {
    await renderConReport([riepilogo({ id: 'rep-1', durationMs: undefined })]);

    const riga = screen.getAllByRole('row')[1];
    expect(within(riga).getByText('—')).toBeInTheDocument();
  });

  it('collega ogni voce al proprio report', async () => {
    await renderConReport([
      riepilogo({ id: 'rep-1' }),
      riepilogo({ id: 'rep-2', generatedAt: '2026-08-19T10:30:00Z' }),
    ]);

    const collegamenti = screen.getAllByRole('link', { name: /Visualizza/ });
    expect(collegamenti[0]).toHaveAttribute('href', '/reports/rep-1');
    expect(collegamenti[1]).toHaveAttribute('href', '/reports/rep-2');
  });

  it('distingue i report falliti da quelli completati', async () => {
    await renderConReport([riepilogo({ id: 'rep-1', status: 'FAILED' })]);

    expect(screen.getByText('Fallito')).toBeInTheDocument();
  });

  it('con lo storico vuoto invita ad avviare un\'operazione', async () => {
    await renderConReport([]);

    expect(screen.getByText(/Nessun report disponibile/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Avvia un'operazione/ })).toHaveAttribute(
      'href',
      '/run',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('se lo storico non si carica lo dichiara invece di mostrare una lista vuota', async () => {
    getMock.mockRejectedValueOnce(new Error('500'));

    render(<ReportsPage />);

    expect(await screen.findByText(/Impossibile caricare i report/)).toBeInTheDocument();
    // Il vuoto per errore non va confuso con il vuoto per assenza di report.
    expect(screen.queryByText(/Nessun report disponibile/)).not.toBeInTheDocument();
  });
});

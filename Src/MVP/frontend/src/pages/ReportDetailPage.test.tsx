import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '../stores/sessionStore';

vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    useParams: () => ({ id: 'rep-1' }),
    Link: ({ to, children, ...rest }: any) => createElement('a', { href: to, ...rest }, children),
  };
});

const getMock = vi.fn();
const streamDownloadMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => getMock(...args),
  },
  streamDownload: (...args: any[]) => streamDownloadMock(...args),
}));

const { ReportDetailPage } = await import('./ReportDetailPage');

const initialSession = useSessionStore.getState();

/** Report completo nella forma restituita da GET /reports/:id. */
function report(over: Record<string, unknown> = {}) {
  return {
    id: 'rep-1',
    taskId: 'task-1',
    agentId: 'security',
    operation: 'SECURITY_OWASP',
    status: 'COMPLETED',
    generatedAt: '2026-08-20T10:30:00Z',
    title: 'Analisi OWASP',
    durationMs: 12500,
    body: [],
    ...over,
  };
}

function finding(over: Record<string, unknown> = {}) {
  return {
    kind: 'finding',
    order: 1,
    owaspCategory: 'A03:2021 – Injection',
    severity: 'critical',
    filePath: 'app/data/user-dao.js',
    startLine: 42,
    endLine: 45,
    explanation: 'Query costruita per concatenazione di stringhe.',
    remediation: 'Usare query parametrizzate.',
    ...over,
  };
}

/** Monta la pagina attendendo che il report sia stato caricato. */
async function renderConReport(dati: Record<string, unknown>) {
  getMock.mockResolvedValueOnce({ data: dati });
  useSessionStore.setState({ token: 'jwt-valido' });
  render(<ReportDetailPage />);
  await screen.findByRole('button', { name: /Esporta PDF/ });
  return userEvent.setup();
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  getMock.mockReset();
  streamDownloadMock.mockReset();
  // jsdom non implementa l'API degli object URL: la sostituiamo per poter
  // osservare che il download venga effettivamente innescato.
  URL.createObjectURL = vi.fn(() => 'blob:finto');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReportDetailPage', () => {
  it('mostra uno stato di caricamento finche\' il report non e\' arrivato', () => {
    getMock.mockReturnValueOnce(new Promise(() => {}));

    render(<ReportDetailPage />);

    expect(screen.getByText(/Caricamento report/)).toBeInTheDocument();
  });

  it('richiede al server proprio il report indicato nell\'indirizzo', async () => {
    await renderConReport(report());

    expect(getMock).toHaveBeenCalledWith('/reports/rep-1');
  });

  it('presenta l\'intestazione con operazione, stato, data e durata', async () => {
    await renderConReport(report());

    expect(screen.getByRole('heading', { name: 'Analisi Sicurezza OWASP' })).toBeInTheDocument();
    expect(screen.getByText('Completato')).toBeInTheDocument();
    expect(screen.getByText(/20\/08\/2026/)).toBeInTheDocument();
    expect(screen.getByText('12.5s')).toBeInTheDocument();
  });

  it('se il report non si carica lo dichiara e offre la via di ritorno', async () => {
    getMock.mockRejectedValueOnce(new Error('404'));

    render(<ReportDetailPage />);

    expect(await screen.findByText(/Impossibile caricare il report/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Torna ai report' })).toHaveAttribute(
      'href',
      '/reports',
    );
  });

  it('mostra la sintesi quando il report la contiene', async () => {
    await renderConReport(report({ summary: 'Rilevate 3 vulnerabilita\' critiche.' }));

    expect(screen.getByText('Rilevate 3 vulnerabilita\' critiche.')).toBeInTheDocument();
  });

  it('renderizza i blocchi di testo formattato', async () => {
    await renderConReport(
      report({ body: [{ kind: 'text', order: 1, markdown: '## Sintesi esecutiva' }] }),
    );

    expect(screen.getByText('## Sintesi esecutiva')).toBeInTheDocument();
  });

  it('renderizza un riscontro con categoria, gravita\' e riferimenti al codice', async () => {
    await renderConReport(report({ body: [finding()] }));

    expect(screen.getByText('A03:2021 – Injection')).toBeInTheDocument();
    // "Critico" e' anche l'etichetta di un pulsante del filtro: qui ci
    // interessa il badge di gravita' del riscontro, che e' uno <span>.
    const badge = screen.getAllByText('Critico').find((el) => el.tagName === 'SPAN');
    expect(badge).toBeDefined();
    expect(screen.getByText(/app\/data\/user-dao\.js/)).toBeInTheDocument();
    expect(screen.getByText(/righe 42–45/)).toBeInTheDocument();
  });

  it('renderizza una violazione di policy con la regola infranta', async () => {
    await renderConReport(
      report({
        operation: 'SECURITY_POLICY',
        body: [
          {
            kind: 'policy_violation',
            order: 1,
            ruleId: 'POL-007',
            ruleText: 'Vietato loggare dati personali',
            filePath: 'src/logger.ts',
            explanation: 'Il logger stampa l\'email utente.',
            remediation: 'Rimuovere il campo email dal log.',
          },
        ],
      }),
    );

    expect(screen.getByText('POL-007')).toBeInTheDocument();
    expect(screen.getByText('Vietato loggare dati personali')).toBeInTheDocument();
    expect(screen.getByText('src/logger.ts')).toBeInTheDocument();
  });

  it('renderizza una voce di changelog con riferimento e titolo', async () => {
    await renderConReport(
      report({
        operation: 'CHANGELOG_TECHNICAL',
        body: [
          {
            kind: 'changelog_item',
            order: 1,
            issueRef: 'ISSUE-42',
            title: 'Aggiunta esportazione PDF',
            detail: 'Il report puo\' ora essere scaricato.',
          },
        ],
      }),
    );

    expect(screen.getByText('ISSUE-42')).toBeInTheDocument();
    expect(screen.getByText('Aggiunta esportazione PDF')).toBeInTheDocument();
    expect(screen.getByText('Il report puo\' ora essere scaricato.')).toBeInTheDocument();
  });

  it('rispetta l\'ordine dichiarato dai blocchi, non quello di arrivo', async () => {
    await renderConReport(
      report({
        body: [
          { kind: 'text', order: 3, markdown: 'Terzo' },
          { kind: 'text', order: 1, markdown: 'Primo' },
          { kind: 'text', order: 2, markdown: 'Secondo' },
        ],
      }),
    );

    const testi = screen.getAllByText(/^(Primo|Secondo|Terzo)$/).map((n) => n.textContent);
    expect(testi).toEqual(['Primo', 'Secondo', 'Terzo']);
  });

  it('ignora i tipi di blocco che non conosce invece di rompersi', async () => {
    await renderConReport(
      report({
        body: [
          { kind: 'text', order: 1, markdown: 'Blocco noto' },
          { kind: 'tipo_dal_futuro', order: 2 },
        ],
      }),
    );

    expect(screen.getByText('Blocco noto')).toBeInTheDocument();
  });

  it('filtra i riscontri per gravita\'', async () => {
    const user = await renderConReport(
      report({
        body: [
          finding({ order: 1, severity: 'critical', owaspCategory: 'Injection critica' }),
          finding({ order: 2, severity: 'low', owaspCategory: 'Header mancante' }),
        ],
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Critico' }));

    expect(screen.getByText('Injection critica')).toBeInTheDocument();
    expect(screen.queryByText('Header mancante')).not.toBeInTheDocument();
  });

  it('avvisa quando il filtro non lascia alcun elemento', async () => {
    const user = await renderConReport(report({ body: [finding({ severity: 'critical' })] }));

    await user.click(screen.getByRole('button', { name: 'Basso' }));

    expect(screen.getByText(/Nessun elemento per il filtro selezionato/)).toBeInTheDocument();
  });

  it('non propone il filtro di gravita\' su un report che non contiene riscontri', async () => {
    await renderConReport(
      report({
        operation: 'CHANGELOG_TECHNICAL',
        body: [{ kind: 'text', order: 1, markdown: 'Solo testo' }],
      }),
    );

    expect(screen.queryByText(/Filtra per severità/)).not.toBeInTheDocument();
  });

  it('mostra la proposta di modifica con il collegamento alla Pull Request', async () => {
    await renderConReport(
      report({
        operation: 'DOCS_INLINE',
        proposal: {
          targetPath: 'src/utils/date.ts',
          diffUnified: '--- a\n+++ b\n+/** documenta */',
          language: 'typescript',
          prUrl: 'https://github.com/OWASP/NodeGoat/pull/7',
        },
      }),
    );

    expect(screen.getByText('Proposta di modifica')).toBeInTheDocument();
    expect(screen.getByText('src/utils/date.ts')).toBeInTheDocument();
    const collegamento = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.includes('/pull/7'));
    expect(collegamento).toBeDefined();
    expect(collegamento).toHaveAttribute('target', '_blank');
  });

  it('esporta il report in PDF e innesca il download', async () => {
    const user = await renderConReport(report());
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    streamDownloadMock.mockResolvedValueOnce(blob);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Esporta PDF/ }));

    await waitFor(() =>
      expect(streamDownloadMock).toHaveBeenCalledWith(
        '/reports/rep-1/export?format=pdf',
        'jwt-valido',
      ),
    );
    expect(click).toHaveBeenCalledTimes(1);
    // L'object URL creato per il download va rilasciato, altrimenti resta
    // allocato per tutta la vita della pagina.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:finto');
  });

  it('se l\'esportazione fallisce lo segnala senza perdere il report a schermo', async () => {
    const user = await renderConReport(report());
    streamDownloadMock.mockRejectedValueOnce(new Error('500'));

    await user.click(screen.getByRole('button', { name: /Esporta PDF/ }));

    expect(await screen.findByText(/Errore durante il download del PDF/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analisi Sicurezza OWASP' })).toBeInTheDocument();
  });

  it('senza token in sessione non tenta l\'esportazione', async () => {
    getMock.mockResolvedValueOnce({ data: report() });
    render(<ReportDetailPage />);
    const bottone = await screen.findByRole('button', { name: /Esporta PDF/ });
    const user = userEvent.setup();

    await user.click(bottone);

    expect(streamDownloadMock).not.toHaveBeenCalled();
  });

  it('mostra i riscontri di piu\' gravita\' diverse quando il filtro e\' su Tutti', async () => {
    await renderConReport(
      report({
        body: [
          finding({ order: 1, severity: 'critical', owaspCategory: 'Injection' }),
          finding({ order: 2, severity: 'info', owaspCategory: 'Nota informativa' }),
        ],
      }),
    );

    const contenuto = screen.getByRole('heading', { name: 'Analisi Sicurezza OWASP' })
      .ownerDocument.body;
    expect(within(contenuto).getByText('Injection')).toBeInTheDocument();
    expect(within(contenuto).getByText('Nota informativa')).toBeInTheDocument();
  });
});

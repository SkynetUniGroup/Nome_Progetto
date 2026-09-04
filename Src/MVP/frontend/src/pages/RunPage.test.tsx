import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '../stores/sessionStore';
import { useSelectionStore } from '../stores/selectionStore';
import type { UserRole } from '../types';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

const postMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    post: (...args: any[]) => postMock(...args),
  },
}));

const { RunPage } = await import('./RunPage');

const initialSession = useSessionStore.getState();
const initialSelection = useSelectionStore.getState();

const CONTESTO = {
  id: 'ctx-1',
  repoOwner: 'OWASP',
  repoName: 'NodeGoat',
  isPrivate: true,
  resolvedSha: 'abc1234567890',
  scopeType: 'FULL_REPOSITORY' as const,
  paths: [],
  detectedLanguages: ['JavaScript'],
  estimatedFileCount: 42,
};

function httpError(status: number) {
  return { response: { status } };
}

/** Prepara sessione e contesto, poi monta la pagina. */
function renderConContesto(role: UserRole = 'SECURITY_AUDITOR') {
  useSessionStore.setState({ user: { id: 'u1', firstName: 'Ada', role }, token: 'jwt' });
  useSelectionStore.getState().setContext(CONTESTO);
  render(<RunPage />);
  return userEvent.setup();
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  useSelectionStore.setState(initialSelection, true);
  navigateMock.mockReset();
  postMock.mockReset();
});

describe('RunPage', () => {
  it('senza un contesto configurato non mostra operazioni ma rimanda alla selezione', async () => {
    useSessionStore.setState({ user: { id: 'u1', firstName: 'Ada', role: 'DEVELOPER' } });
    render(<RunPage />);
    const user = userEvent.setup();

    expect(screen.getByText(/Nessun contesto configurato/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Analisi Sicurezza/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Vai a Repository' }));
    expect(navigateMock).toHaveBeenCalledWith({ to: '/select' });
  });

  it('riepiloga il contesto attivo: repository, SHA abbreviato, ambito e linguaggi', () => {
    renderConContesto();

    expect(screen.getByText('OWASP/NodeGoat')).toBeInTheDocument();
    expect(screen.getByText('abc12345')).toBeInTheDocument();
    expect(screen.getByText(/FULL_REPOSITORY/)).toBeInTheDocument();
    expect(screen.getByText(/JavaScript/)).toBeInTheDocument();
    expect(screen.getByText(/42 file stimati/)).toBeInTheDocument();
  });

  it('elenca le sole operazioni permesse al ruolo Security Auditor', () => {
    renderConContesto('SECURITY_AUDITOR');

    expect(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verifica Policy/ })).toBeInTheDocument();
    // Le operazioni di documentazione appartengono al ruolo Developer.
    expect(screen.queryByRole('button', { name: /Documentazione README/ })).not.toBeInTheDocument();
  });

  it('elenca le quattro operazioni del ruolo Developer', () => {
    renderConContesto('DEVELOPER');

    for (const etichetta of [
      /Documentazione README/,
      /Documentazione Inline/,
      /Documentazione API/,
      /Changelog Tecnico/,
    ]) {
      expect(screen.getByRole('button', { name: etichetta })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Analisi Sicurezza/ })).not.toBeInTheDocument();
  });

  it('elenca le due operazioni del ruolo Project Manager', () => {
    renderConContesto('PROJECT_MANAGER');

    expect(screen.getByRole('button', { name: /Changelog Tecnico/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Changelog Business/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Verifica Policy/ })).not.toBeInTheDocument();
  });

  it('selezionare e deselezionare la stessa operazione la riporta allo stato iniziale', async () => {
    const user = renderConContesto();
    const carta = screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ });
    expect(carta).toHaveAttribute('aria-pressed', 'false');

    await user.click(carta);
    expect(carta).toHaveAttribute('aria-pressed', 'true');

    await user.click(carta);
    expect(carta).toHaveAttribute('aria-pressed', 'false');
  });

  it('permette di selezionare piu\' operazioni contemporaneamente', async () => {
    const user = renderConContesto();

    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));
    await user.click(screen.getByRole('button', { name: /Verifica Policy/ }));

    expect(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Verifica Policy/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Avvia 2 operazioni' })).toBeInTheDocument();
  });

  it('senza alcuna operazione selezionata il pulsante di avvio e\' inerte', async () => {
    const user = renderConContesto();
    const avvio = screen.getByRole('button', { name: /Seleziona almeno un'operazione/ });

    expect(avvio).toBeDisabled();
    await user.click(avvio);

    expect(postMock).not.toHaveBeenCalled();
  });

  it('avvia le operazioni selezionate sul contesto corrente e passa al monitoraggio', async () => {
    const user = renderConContesto();
    postMock.mockResolvedValueOnce({ data: {} });
    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));
    await user.click(screen.getByRole('button', { name: /Verifica Policy/ }));

    await user.click(screen.getByRole('button', { name: 'Avvia 2 operazioni' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/tasks' }));
    expect(postMock).toHaveBeenCalledWith('/tasks', {
      contextId: 'ctx-1',
      operations: ['SECURITY_OWASP', 'SECURITY_POLICY'],
    });
  });

  it('con una sola operazione il pulsante lo dice al singolare', async () => {
    const user = renderConContesto();

    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));

    expect(screen.getByRole('button', { name: 'Avvia operazione' })).toBeInTheDocument();
  });

  it('al superamento del limite di utilizzo (402) lo dichiara e non naviga', async () => {
    const user = renderConContesto();
    postMock.mockRejectedValueOnce(httpError(402));
    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));

    await user.click(screen.getByRole('button', { name: 'Avvia operazione' }));

    expect(await screen.findByText(/Limite di utilizzo del modello AI raggiunto/)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('se il contesto non esiste piu\' (404) invita a ricrearlo', async () => {
    const user = renderConContesto();
    postMock.mockRejectedValueOnce(httpError(404));
    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));

    await user.click(screen.getByRole('button', { name: 'Avvia operazione' }));

    expect(await screen.findByText(/Contesto non trovato/)).toBeInTheDocument();
  });

  it('per ogni altro errore mostra un messaggio generico di avvio fallito', async () => {
    const user = renderConContesto();
    postMock.mockRejectedValueOnce(httpError(500));
    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));

    await user.click(screen.getByRole('button', { name: 'Avvia operazione' }));

    expect(await screen.findByText(/Errore durante l'avvio delle operazioni/)).toBeInTheDocument();
  });

  it('cambiando selezione dopo un errore il messaggio sparisce', async () => {
    const user = renderConContesto();
    postMock.mockRejectedValueOnce(httpError(500));
    await user.click(screen.getByRole('button', { name: /Analisi Sicurezza OWASP/ }));
    await user.click(screen.getByRole('button', { name: 'Avvia operazione' }));
    await screen.findByText(/Errore durante l'avvio/);

    await user.click(screen.getByRole('button', { name: /Verifica Policy/ }));

    expect(screen.queryByText(/Errore durante l'avvio/)).not.toBeInTheDocument();
  });

  it('consente di tornare alla selezione del repository per cambiare contesto', async () => {
    const user = renderConContesto();

    await user.click(screen.getByRole('button', { name: 'Cambia contesto' }));

    expect(navigateMock).toHaveBeenCalledWith({ to: '/select' });
  });
});

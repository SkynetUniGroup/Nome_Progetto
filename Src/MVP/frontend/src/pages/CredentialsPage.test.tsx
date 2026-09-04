import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '../stores/sessionStore';

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => getMock(...args),
    post: (...args: any[]) => postMock(...args),
  },
}));

const { CredentialsPage } = await import('./CredentialsPage');

const initialSession = useSessionStore.getState();

const PAT_VALIDO = 'ghp_1234567890abcdef';
const CHIAVE_VALIDA = 'sk-1234567890abcdef';

/** Credenziale GitHub nella forma restituita da GET /credentials. */
function credenziale(status: 'CONNECTED' | 'INVALID', lastValidatedAt: string | null = null) {
  return { id: 'cred-1', provider: 'GITHUB', status, lastValidatedAt };
}

/** Compila entrambi i segreti e restituisce lo user-event gia' pronto. */
async function compilaSegreti(pat = PAT_VALIDO, chiave = CHIAVE_VALIDA) {
  const user = userEvent.setup();
  if (pat) await user.type(screen.getByLabelText('GitHub Personal Access Token'), pat);
  if (chiave) await user.type(screen.getByLabelText('OpenAI API Key'), chiave);
  return user;
}

/** Attende che il caricamento iniziale (GET /credentials) sia concluso. */
async function attendiCaricamento() {
  await screen.findByText('Stato credenziali');
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  getMock.mockReset().mockResolvedValue({ data: [] });
  postMock.mockReset();
});

describe('CredentialsPage', () => {
  it('al montaggio legge lo stato delle credenziali dal server', async () => {
    getMock.mockResolvedValueOnce({ data: [credenziale('CONNECTED', '2026-08-20T10:30:00Z')] });

    render(<CredentialsPage />);

    await attendiCaricamento();
    expect(getMock).toHaveBeenCalledWith('/credentials');
    expect(useSessionStore.getState().credentialsStatus).toBe('connected');
    expect(screen.getByText('Connessa e valida')).toBeInTheDocument();
  });

  it('segnala le credenziali come non configurate quando il server non ne restituisce', async () => {
    getMock.mockResolvedValueOnce({ data: [] });

    render(<CredentialsPage />);

    await attendiCaricamento();
    expect(useSessionStore.getState().credentialsStatus).toBe('missing');
    expect(screen.getByText('Non configurata')).toBeInTheDocument();
  });

  it('segnala le credenziali come non valide se il server le riporta INVALID', async () => {
    getMock.mockResolvedValueOnce({ data: [credenziale('INVALID')] });

    render(<CredentialsPage />);

    await attendiCaricamento();
    expect(useSessionStore.getState().credentialsStatus).toBe('invalid');
    expect(screen.getByText('Non valida – aggiorna')).toBeInTheDocument();
  });

  it('se la lettura iniziale fallisce assume credenziali mancanti invece di bloccarsi', async () => {
    getMock.mockRejectedValueOnce(new Error('backend giu'));

    render(<CredentialsPage />);

    await attendiCaricamento();
    expect(useSessionStore.getState().credentialsStatus).toBe('missing');
  });

  it('mostra la data dell\'ultima validazione quando presente', async () => {
    getMock.mockResolvedValueOnce({ data: [credenziale('CONNECTED', '2026-08-20T10:30:00Z')] });

    render(<CredentialsPage />);

    expect(await screen.findByText(/Ultima validazione:/)).toBeInTheDocument();
  });

  it('salva le credenziali e ne fa verificare la validita\' ai servizi esterni', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { valid: true } });
    getMock.mockResolvedValueOnce({ data: [credenziale('CONNECTED', '2026-08-20T10:30:00Z')] });
    const user = await compilaSegreti();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    await waitFor(() => expect(useSessionStore.getState().credentialsStatus).toBe('connected'));
    expect(postMock).toHaveBeenNthCalledWith(1, '/credentials', {
      githubPat: PAT_VALIDO,
      openaiApiKey: CHIAVE_VALIDA,
    });
    // La validazione e' una chiamata a parte: il salvataggio da solo non
    // basta a dichiarare valide le credenziali.
    expect(postMock).toHaveBeenNthCalledWith(2, '/credentials/validate');
  });

  it('dopo il salvataggio svuota i campi, cosi\' i segreti non restano nel browser', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { valid: true } });
    getMock.mockResolvedValueOnce({ data: [credenziale('CONNECTED')] });
    const user = await compilaSegreti();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    await waitFor(() =>
      expect(screen.getByLabelText('GitHub Personal Access Token')).toHaveValue(''),
    );
    expect(screen.getByLabelText('OpenAI API Key')).toHaveValue('');
  });

  it('se i servizi esterni rifiutano le credenziali le marca non valide e riporta il motivo', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { valid: false, message: 'Il token GitHub e\' scaduto.' } });
    const user = await compilaSegreti();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    expect(await screen.findByText('Il token GitHub e\' scaduto.')).toBeInTheDocument();
    expect(useSessionStore.getState().credentialsStatus).toBe('invalid');
  });

  it('se il server non spiega il motivo del rifiuto mostra comunque un messaggio', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { valid: false } });
    const user = await compilaSegreti();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    expect(await screen.findByText('Le credenziali non sono valide.')).toBeInTheDocument();
  });

  it('interrompe il salvataggio e avvisa se la chiamata fallisce', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    postMock.mockRejectedValueOnce(new Error('rete assente'));
    const user = await compilaSegreti();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    expect(await screen.findByText(/Errore durante il salvataggio/)).toBeInTheDocument();
  });

  it('rifiuta un PAT dal formato non valido senza contattare il server', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    const user = await compilaSegreti('token-qualsiasi');

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    expect(
      await screen.findByText('Il PAT GitHub deve iniziare con ghp_ oppure github_pat_'),
    ).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('accetta anche il formato github_pat_ dei token a granularita\' fine', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { valid: true } });
    getMock.mockResolvedValueOnce({ data: [credenziale('CONNECTED')] });
    const user = await compilaSegreti('github_pat_11ABCDE');

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1].githubPat).toBe('github_pat_11ABCDE');
  });

  it('rifiuta una chiave OpenAI dal formato non valido senza contattare il server', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    const user = await compilaSegreti(PAT_VALIDO, 'chiave-non-valida');

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    expect(await screen.findByText('La chiave OpenAI deve iniziare con sk-')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('segnala i campi lasciati vuoti', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    expect(await screen.findByText('Inserisci il GitHub PAT')).toBeInTheDocument();
    expect(screen.getByText('Inserisci la chiave API OpenAI')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('mentre verifica lo dichiara e blocca il pulsante', async () => {
    render(<CredentialsPage />);
    await attendiCaricamento();
    let concludiVerifica: (v: unknown) => void = () => {};
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockImplementationOnce(() => new Promise((resolve) => { concludiVerifica = resolve; }));
    const user = await compilaSegreti();

    await user.click(screen.getByRole('button', { name: /Salva e verifica/ }));

    const bottone = await screen.findByRole('button', { name: /Verifica in corso/ });
    expect(bottone).toBeDisabled();
    getMock.mockResolvedValueOnce({ data: [credenziale('CONNECTED')] });
    concludiVerifica({ data: { valid: true } });
    await waitFor(() => expect(bottone).not.toBeDisabled());
  });
});

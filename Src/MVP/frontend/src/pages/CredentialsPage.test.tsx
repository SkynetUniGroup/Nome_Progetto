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

/** Credenziale nella forma restituita dal backend: nessun segreto, nessuno stato. */
function credenziale(connectedAt = '2026-08-20T10:30:00Z') {
  return { id: 'cred-1', provider: 'GITHUB', connectedAt };
}

function httpError(status: number) {
  return { response: { status } };
}

/** Monta la pagina attendendo la fine della lettura iniziale. */
async function renderCaricata() {
  render(<CredentialsPage />);
  await screen.findByText('Stato credenziali');
  return userEvent.setup();
}

async function inserisciPat(user: ReturnType<typeof userEvent.setup>, pat = PAT_VALIDO) {
  await user.type(screen.getByLabelText('GitHub Personal Access Token'), pat);
}

const SALVA = /Salva e verifica/;

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  getMock.mockReset().mockResolvedValue({ data: [] });
  postMock.mockReset();
});

describe('CredentialsPage', () => {
  describe('stato iniziale', () => {
    it('legge le credenziali memorizzate al montaggio', async () => {
      getMock.mockResolvedValueOnce({ data: [credenziale()] });

      await renderCaricata();

      expect(getMock).toHaveBeenCalledWith('/credentials');
      expect(useSessionStore.getState().credentialsStatus).toBe('connected');
      expect(screen.getByText('Connessa e valida')).toBeInTheDocument();
    });

    it('considera configurata la credenziale per il solo fatto che esiste', async () => {
      // Il backend verifica il token su GitHub prima di salvarlo: una
      // credenziale memorizzata e' per costruzione una che ha funzionato.
      getMock.mockResolvedValueOnce({ data: [credenziale()] });

      await renderCaricata();

      expect(useSessionStore.getState().credentialsStatus).toBe('connected');
    });

    it('segnala l\'assenza quando il server non restituisce credenziali', async () => {
      getMock.mockResolvedValueOnce({ data: [] });

      await renderCaricata();

      expect(useSessionStore.getState().credentialsStatus).toBe('missing');
      expect(screen.getByText('Non configurata')).toBeInTheDocument();
    });

    it('ignora le credenziali di altri provider', async () => {
      getMock.mockResolvedValueOnce({
        data: [{ id: 'x', provider: 'ALTRO', connectedAt: '2026-08-20T10:30:00Z' }],
      });

      await renderCaricata();

      expect(useSessionStore.getState().credentialsStatus).toBe('missing');
    });

    it('se la lettura fallisce assume mancanti invece di bloccarsi', async () => {
      getMock.mockRejectedValueOnce(new Error('backend giu'));

      await renderCaricata();

      expect(useSessionStore.getState().credentialsStatus).toBe('missing');
    });

    it('mostra la data dell\'ultima verifica', async () => {
      getMock.mockResolvedValueOnce({ data: [credenziale()] });

      await renderCaricata();

      expect(screen.getByText(/Ultima verifica:/)).toBeInTheDocument();
    });

    it('senza credenziale non propone di verificarla di nuovo', async () => {
      await renderCaricata();

      expect(screen.queryByRole('button', { name: /Verifica di nuovo/ })).not.toBeInTheDocument();
    });
  });

  describe('salvataggio', () => {
    it('invia il token nella forma che il backend dichiara', async () => {
      const user = await renderCaricata();
      postMock.mockResolvedValueOnce({ data: credenziale() });
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith('/credentials', {
          provider: 'GITHUB',
          token: PAT_VALIDO,
        }),
      );
    });

    it('salvare e verificare sono un passo solo', async () => {
      // Il backend interroga GitHub prima di persistere: una POST riuscita
      // significa gia' token valido, non serve una seconda chiamata.
      const user = await renderCaricata();
      postMock.mockResolvedValueOnce({ data: credenziale() });
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      await waitFor(() => expect(useSessionStore.getState().credentialsStatus).toBe('connected'));
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it('dopo il salvataggio svuota il campo, cosi\' il segreto non resta nel browser', async () => {
      const user = await renderCaricata();
      postMock.mockResolvedValueOnce({ data: credenziale() });
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      await waitFor(() =>
        expect(screen.getByLabelText('GitHub Personal Access Token')).toHaveValue(''),
      );
    });

    it('mostra la data di verifica restituita dal salvataggio', async () => {
      const user = await renderCaricata();
      postMock.mockResolvedValueOnce({ data: credenziale('2026-09-05T09:00:00Z') });
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      expect(await screen.findByText(/05\/09\/26/)).toBeInTheDocument();
    });

    it('se GitHub rifiuta il token lo dichiara e marca le credenziali non valide', async () => {
      const user = await renderCaricata();
      postMock.mockRejectedValueOnce(httpError(401));
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      expect(await screen.findByText(/GitHub ha rifiutato il token/)).toBeInTheDocument();
      expect(useSessionStore.getState().credentialsStatus).toBe('invalid');
    });

    it('distingue un guasto del server dal token rifiutato', async () => {
      // Un 500 non dice nulla sul token: marcarlo invalido manderebbe
      // l'utente a rigenerarne uno perfettamente buono.
      const user = await renderCaricata();
      postMock.mockRejectedValueOnce(httpError(500));
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      expect(await screen.findByText(/Errore durante il salvataggio/)).toBeInTheDocument();
      expect(useSessionStore.getState().credentialsStatus).not.toBe('invalid');
    });

    it('dichiara la verifica in corso e blocca il pulsante', async () => {
      const user = await renderCaricata();
      let concludi: (v: unknown) => void = () => {};
      postMock.mockImplementationOnce(() => new Promise((resolve) => { concludi = resolve; }));
      await inserisciPat(user);

      await user.click(screen.getByRole('button', { name: SALVA }));

      const bottone = await screen.findByRole('button', { name: /Verifica in corso/ });
      expect(bottone).toBeDisabled();
      concludi({ data: credenziale() });
      await waitFor(() => expect(bottone).not.toBeDisabled());
    });
  });

  describe('validazione del formato', () => {
    it('rifiuta un PAT dal formato non valido senza contattare il server', async () => {
      const user = await renderCaricata();
      await inserisciPat(user, 'token-qualsiasi');

      await user.click(screen.getByRole('button', { name: SALVA }));

      expect(
        await screen.findByText('Il PAT GitHub deve iniziare con ghp_ oppure github_pat_'),
      ).toBeInTheDocument();
      expect(postMock).not.toHaveBeenCalled();
    });

    it('accetta il formato github_pat_ dei token a granularita\' fine', async () => {
      const user = await renderCaricata();
      postMock.mockResolvedValueOnce({ data: credenziale() });
      await inserisciPat(user, 'github_pat_11ABCDE');

      await user.click(screen.getByRole('button', { name: SALVA }));

      await waitFor(() => expect(postMock).toHaveBeenCalled());
      expect(postMock.mock.calls[0][1].token).toBe('github_pat_11ABCDE');
    });

    it('segnala il campo lasciato vuoto', async () => {
      const user = await renderCaricata();

      await user.click(screen.getByRole('button', { name: SALVA }));

      expect(await screen.findByText('Inserisci il GitHub PAT')).toBeInTheDocument();
      expect(postMock).not.toHaveBeenCalled();
    });

    it('toglie l\'errore appena l\'utente corregge il campo', async () => {
      const user = await renderCaricata();
      await user.click(screen.getByRole('button', { name: SALVA }));
      await screen.findByText('Inserisci il GitHub PAT');

      await inserisciPat(user, 'g');

      expect(screen.queryByText('Inserisci il GitHub PAT')).not.toBeInTheDocument();
    });
  });

  describe('nuova verifica su richiesta', () => {
    it('richiede al backend di ricontrollare il token memorizzato', async () => {
      getMock.mockResolvedValueOnce({ data: [credenziale()] });
      const user = await renderCaricata();
      postMock.mockResolvedValueOnce({ data: credenziale('2026-09-05T09:00:00Z') });

      await user.click(screen.getByRole('button', { name: /Verifica di nuovo/ }));

      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith('/credentials/cred-1/validate'),
      );
      expect(await screen.findByText(/05\/09\/26/)).toBeInTheDocument();
    });

    it('se il token memorizzato non vale piu\' lo dichiara', async () => {
      getMock.mockResolvedValueOnce({ data: [credenziale()] });
      const user = await renderCaricata();
      postMock.mockRejectedValueOnce(httpError(401));

      await user.click(screen.getByRole('button', { name: /Verifica di nuovo/ }));

      expect(
        await screen.findByText(/Il token memorizzato non è più valido/),
      ).toBeInTheDocument();
      expect(useSessionStore.getState().credentialsStatus).toBe('invalid');
    });
  });
});

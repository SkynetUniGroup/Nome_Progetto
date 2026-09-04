import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, streamDownload, AxiosError } from './client';
import { useSessionStore } from '../stores/sessionStore';

const initialSession = useSessionStore.getState();

/**
 * Esegue la catena di interceptor di richiesta sulla configurazione data,
 * restituendo la configurazione come partirebbe davvero verso la rete.
 * Evita di dover aprire una connessione per osservare gli header.
 */
async function applicaInterceptor(config: Record<string, any> = {}) {
  const handlers = (apiClient.interceptors.request as any).handlers.filter(Boolean);
  let risultato: any = { headers: {}, ...config };
  for (const handler of handlers) {
    risultato = await handler.fulfilled(risultato);
  }
  return risultato;
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiClient', () => {
  it('usa un percorso relativo come base, per restare sulla stessa origine', () => {
    // Un dominio assoluto qui romperebbe il vincolo same-origin e
    // richiederebbe una configurazione CORS.
    expect(apiClient.defaults.baseURL).toBe('/api/v1');
    expect(apiClient.defaults.baseURL?.startsWith('http')).toBe(false);
  });

  it('non invia cookie: l\'autenticazione passa solo dal token', () => {
    expect(apiClient.defaults.withCredentials).toBe(false);
  });

  it('aggiunge il token di sessione alle richieste come Bearer', async () => {
    useSessionStore.setState({ token: 'jwt-corrente' });

    const config = await applicaInterceptor();

    expect(config.headers.Authorization).toBe('Bearer jwt-corrente');
  });

  it('non aggiunge alcun header di autorizzazione se la sessione e\' chiusa', async () => {
    const config = await applicaInterceptor();

    expect(config.headers.Authorization).toBeUndefined();
  });

  it('legge il token al momento della richiesta, non a quello del modulo', async () => {
    // Se il token venisse letto una volta sola all'import, dopo un login
    // le chiamate partirebbero ancora senza autorizzazione.
    const primaDelLogin = await applicaInterceptor();
    expect(primaDelLogin.headers.Authorization).toBeUndefined();

    useSessionStore.setState({ token: 'jwt-appena-ottenuto' });
    const dopoIlLogin = await applicaInterceptor();

    expect(dopoIlLogin.headers.Authorization).toBe('Bearer jwt-appena-ottenuto');
  });

  it('usa il token nuovo dopo un cambio di sessione', async () => {
    useSessionStore.setState({ token: 'jwt-vecchio' });
    await applicaInterceptor();

    useSessionStore.setState({ token: 'jwt-nuovo' });
    const config = await applicaInterceptor();

    expect(config.headers.Authorization).toBe('Bearer jwt-nuovo');
  });

  it('riespone AxiosError, cosi\' i chiamanti non devono importare axios', () => {
    expect(AxiosError).toBeDefined();
    expect(typeof AxiosError).toBe('function');
  });
});

describe('streamDownload', () => {
  it('scarica il file dal percorso indicato autenticandosi col token', async () => {
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, blob: async () => blob } as Response);

    const risultato = await streamDownload('/reports/rep-1/export?format=pdf', 'jwt-valido');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reports/rep-1/export?format=pdf', {
      headers: { Authorization: 'Bearer jwt-valido' },
    });
    expect(risultato).toBe(blob);
  });

  it('solleva un errore parlante se il server rifiuta il download', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      blob: async () => new Blob(),
    } as Response);

    await expect(streamDownload('/reports/rep-1/export?format=pdf', 'jwt')).rejects.toThrow(
      'Download failed with status 403',
    );
  });

  it('non restituisce un Blob vuoto al posto di un errore', async () => {
    // Un download fallito che restituisse un Blob produrrebbe un PDF corrotto
    // salvato sul disco dell'utente senza alcun avviso.
    const blob = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      blob,
    } as unknown as Response);

    await expect(streamDownload('/x', 'jwt')).rejects.toThrow();
    expect(blob).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '../stores/sessionStore';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    useNavigate: () => navigateMock,
    Link: ({ to, children, ...rest }: any) => createElement('a', { href: to, ...rest }, children),
  };
});

const postMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    post: (...args: any[]) => postMock(...args),
  },
}));

const { RegisterPage } = await import('./RegisterPage');

const initialSession = useSessionStore.getState();

const AUTH_OK = {
  data: {
    token: 'jwt-nuovo-utente',
    user: { id: 'u9', firstName: 'Marco', role: 'DEVELOPER' },
  },
};

function httpError(status: number) {
  return { response: { status } };
}

/**
 * Compila l'intero modulo con dati validi, permettendo di sovrascrivere i
 * singoli campi per isolare lo scenario sotto esame.
 */
async function compilaModulo(override: Partial<Record<string, string>> = {}) {
  const dati = {
    Nome: 'Marco',
    Cognome: 'Rossi',
    Email: 'marco@azienda.it',
    Password: 'password-lunga',
    'Conferma Password': 'password-lunga',
    ...override,
  };
  const user = userEvent.setup();
  for (const [etichetta, valore] of Object.entries(dati)) {
    if (valore) await user.type(screen.getByLabelText(etichetta), valore);
  }
  return user;
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  navigateMock.mockReset();
  postMock.mockReset();
});

describe('RegisterPage', () => {
  it('mostra tutti i campi richiesti e il collegamento al login', () => {
    render(<RegisterPage />);

    for (const etichetta of ['Nome', 'Cognome', 'Email', 'Password', 'Conferma Password', 'Ruolo']) {
      expect(screen.getByLabelText(etichetta)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Accedi' })).toHaveAttribute('href', '/login');
  });

  it('propone i tre ruoli operativi previsti', () => {
    render(<RegisterPage />);

    const opzioni = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opzioni).toEqual(['Developer', 'Security Auditor', 'Project Manager']);
  });

  it('registra l\'utente, apre la sessione e lo porta alla configurazione delle credenziali', async () => {
    postMock.mockResolvedValueOnce(AUTH_OK);
    render(<RegisterPage />);
    const user = await compilaModulo();

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/credentials' }));
    expect(postMock).toHaveBeenCalledWith('/auth/register', {
      firstName: 'Marco',
      lastName: 'Rossi',
      email: 'marco@azienda.it',
      password: 'password-lunga',
      role: 'DEVELOPER',
    });
    expect(useSessionStore.getState().token).toBe('jwt-nuovo-utente');
  });

  it('invia il ruolo operativo scelto dall\'utente', async () => {
    postMock.mockResolvedValueOnce(AUTH_OK);
    render(<RegisterPage />);
    const user = await compilaModulo();
    await user.selectOptions(screen.getByLabelText('Ruolo'), 'SECURITY_AUDITOR');

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1].role).toBe('SECURITY_AUDITOR');
  });

  it('ripulisce nome, cognome ed email dagli spazi in eccesso', async () => {
    postMock.mockResolvedValueOnce(AUTH_OK);
    render(<RegisterPage />);
    const user = await compilaModulo({
      Nome: '  Marco  ',
      Cognome: '  Rossi  ',
      Email: '  marco@azienda.it  ',
    });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1]).toMatchObject({
      firstName: 'Marco',
      lastName: 'Rossi',
      email: 'marco@azienda.it',
    });
  });

  it('senza nome non contatta il server', async () => {
    render(<RegisterPage />);
    const user = await compilaModulo({ Nome: '' });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText('Inserisci il nome')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('senza cognome non contatta il server', async () => {
    render(<RegisterPage />);
    const user = await compilaModulo({ Cognome: '' });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText('Inserisci il cognome')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('senza email non contatta il server', async () => {
    render(<RegisterPage />);
    const user = await compilaModulo({ Email: '' });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText('Inserisci la email')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rifiuta un\'email dal formato non valido', async () => {
    render(<RegisterPage />);
    const user = await compilaModulo({ Email: 'marco-chiocciola-azienda' });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText('Email non valida')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rifiuta una password piu\' corta di otto caratteri', async () => {
    render(<RegisterPage />);
    const user = await compilaModulo({ Password: 'corta', 'Conferma Password': 'corta' });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(
      await screen.findByText('La password deve essere di almeno 8 caratteri'),
    ).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rifiuta la registrazione se la conferma password non coincide', async () => {
    render(<RegisterPage />);
    const user = await compilaModulo({ 'Conferma Password': 'password-diversa' });

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText('Le password non coincidono')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('con email gia\' registrata (409) lo dice esplicitamente e non apre la sessione', async () => {
    postMock.mockRejectedValueOnce(httpError(409));
    render(<RegisterPage />);
    const user = await compilaModulo();

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText('Esiste già un account con questa email.')).toBeInTheDocument();
    expect(useSessionStore.getState().token).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('con un errore diverso mostra un messaggio generico di registrazione fallita', async () => {
    postMock.mockRejectedValueOnce(httpError(500));
    render(<RegisterPage />);
    const user = await compilaModulo();

    await user.click(screen.getByRole('button', { name: 'Registrati' }));

    expect(await screen.findByText(/Errore durante la registrazione/)).toBeInTheDocument();
    expect(useSessionStore.getState().token).toBeNull();
  });

  it('disabilita il pulsante mentre la registrazione e\' in corso', async () => {
    let sblocca: (v: unknown) => void = () => {};
    postMock.mockImplementationOnce(() => new Promise((resolve) => { sblocca = resolve; }));
    render(<RegisterPage />);
    const user = await compilaModulo();
    const bottone = screen.getByRole('button', { name: 'Registrati' });

    await user.click(bottone);

    await waitFor(() => expect(bottone).toBeDisabled());
    sblocca(AUTH_OK);
    await waitFor(() => expect(bottone).not.toBeDisabled());
  });
});

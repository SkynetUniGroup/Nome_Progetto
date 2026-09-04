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

const { LoginPage } = await import('./LoginPage');

const initialSession = useSessionStore.getState();

/** Risposta di /auth/login in caso di credenziali corrette. */
const AUTH_OK = {
  data: {
    token: 'jwt-valido',
    user: { id: 'u1', firstName: 'Ada', role: 'DEVELOPER' },
  },
};

/** Errore HTTP nella forma in cui axios lo propaga. */
function httpError(status: number) {
  return { response: { status } };
}

async function compilaCredenziali(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  return user;
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  navigateMock.mockReset();
  postMock.mockReset();
});

describe('LoginPage', () => {
  it('mostra i campi credenziali e il collegamento alla registrazione', () => {
    render(<LoginPage />);

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accedi' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Registrati' })).toHaveAttribute('href', '/register');
  });

  it('con credenziali corrette autentica l\'utente e lo porta alla selezione del repository', async () => {
    postMock.mockResolvedValueOnce(AUTH_OK);
    render(<LoginPage />);
    const user = await compilaCredenziali('ada@azienda.it', 'password-giusta');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/select' }));
    expect(postMock).toHaveBeenCalledWith('/auth/login', {
      email: 'ada@azienda.it',
      password: 'password-giusta',
    });
    expect(useSessionStore.getState().token).toBe('jwt-valido');
    expect(useSessionStore.getState().user).toEqual(AUTH_OK.data.user);
  });

  it('ripulisce l\'email dagli spazi prima di inviarla', async () => {
    postMock.mockResolvedValueOnce(AUTH_OK);
    render(<LoginPage />);
    const user = await compilaCredenziali('  ada@azienda.it  ', 'password-giusta');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1].email).toBe('ada@azienda.it');
  });

  it('con credenziali errate (401) mostra un errore generico e non apre la sessione', async () => {
    postMock.mockRejectedValueOnce(httpError(401));
    render(<LoginPage />);
    const user = await compilaCredenziali('ada@azienda.it', 'password-sbagliata');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    expect(await screen.findByText('Email o password non corretti.')).toBeInTheDocument();
    expect(useSessionStore.getState().token).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('non rivela se l\'email esiste: 401 e 403 producono lo stesso messaggio', async () => {
    // RF.9 chiede un errore *generico*: un messaggio diverso a seconda del
    // codice permetterebbe di distinguere "utente inesistente" da "password
    // sbagliata", cioe' di enumerare gli account registrati.
    postMock.mockRejectedValueOnce(httpError(401));
    const { unmount } = render(<LoginPage />);
    let user = await compilaCredenziali('ada@azienda.it', 'x');
    await user.click(screen.getByRole('button', { name: 'Accedi' }));
    const messaggio401 = (await screen.findByText(/non corretti/)).textContent;
    unmount();

    postMock.mockRejectedValueOnce(httpError(403));
    render(<LoginPage />);
    user = await compilaCredenziali('ada@azienda.it', 'x');
    await user.click(screen.getByRole('button', { name: 'Accedi' }));
    const messaggio403 = (await screen.findByText(/non corretti/)).textContent;

    expect(messaggio403).toBe(messaggio401);
    expect(messaggio403).not.toContain('ada@azienda.it');
  });

  it('distingue un guasto di rete da credenziali errate', async () => {
    postMock.mockRejectedValueOnce(new Error('network down'));
    render(<LoginPage />);
    const user = await compilaCredenziali('ada@azienda.it', 'password-giusta');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    expect(await screen.findByText(/Errore di rete/)).toBeInTheDocument();
  });

  it('senza email non contatta il server e segnala il campo mancante', async () => {
    render(<LoginPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Password'), 'password-giusta');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    expect(await screen.findByText('Inserisci la tua email')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('senza password non contatta il server e segnala il campo mancante', async () => {
    render(<LoginPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ada@azienda.it');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    expect(await screen.findByText('Inserisci la password')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rifiuta un\'email dal formato non valido senza contattare il server', async () => {
    render(<LoginPage />);
    const user = await compilaCredenziali('non-e-una-email', 'password-giusta');

    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    expect(await screen.findByText('Email non valida')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('toglie l\'errore di validazione appena l\'utente corregge il campo', async () => {
    render(<LoginPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Accedi' }));
    expect(await screen.findByText('Inserisci la tua email')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'a');

    await waitFor(() =>
      expect(screen.queryByText('Inserisci la tua email')).not.toBeInTheDocument(),
    );
  });

  it('disabilita il pulsante mentre la richiesta e\' in corso, per evitare invii doppi', async () => {
    let sblocca: (v: unknown) => void = () => {};
    postMock.mockImplementationOnce(() => new Promise((resolve) => { sblocca = resolve; }));
    render(<LoginPage />);
    const user = await compilaCredenziali('ada@azienda.it', 'password-giusta');
    const bottone = screen.getByRole('button', { name: 'Accedi' });

    await user.click(bottone);

    await waitFor(() => expect(bottone).toBeDisabled());
    sblocca(AUTH_OK);
    await waitFor(() => expect(bottone).not.toBeDisabled());
  });
});

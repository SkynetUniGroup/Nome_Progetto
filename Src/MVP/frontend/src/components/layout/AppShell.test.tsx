import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '../../stores/sessionStore';
import type { UserRole } from '../../types';

const navigateMock = vi.fn();
let pathnameCorrente = '/tasks';

vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    Outlet: () => createElement('div', { 'data-testid': 'contenuto-pagina' }),
    Link: ({ to, children, ...rest }: any) => createElement('a', { href: to, ...rest }, children),
    useNavigate: () => navigateMock,
    useRouterState: () => ({ location: { pathname: pathnameCorrente } }),
  };
});

// L'hook WebSocket ha una suite dedicata: qui interessa che AppShell lo
// monti una sola volta, non come si comporta la connessione.
const useWebSocketMock = vi.fn();
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => useWebSocketMock(),
}));

const { AppShell } = await import('./AppShell');

const initialSession = useSessionStore.getState();

function autentica(role: UserRole = 'DEVELOPER', firstName = 'Ada') {
  useSessionStore.setState({ user: { id: 'u1', firstName, role }, token: 'jwt' });
}

beforeEach(() => {
  useSessionStore.setState(initialSession, true);
  navigateMock.mockReset();
  useWebSocketMock.mockReset();
  pathnameCorrente = '/tasks';
});

describe('AppShell', () => {
  it('apre la connessione in tempo reale una sola volta per l\'intera area autenticata', () => {
    autentica();

    render(<AppShell />);

    expect(useWebSocketMock).toHaveBeenCalledTimes(1);
  });

  it('espone le cinque voci di navigazione previste', () => {
    autentica();

    render(<AppShell />);

    const nav = screen.getByRole('navigation');
    const voci = within(nav)
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')]);
    expect(voci).toEqual([
      ['Credenziali', '/credentials'],
      ['Repository', '/select'],
      ['Avvia', '/run'],
      ['Task', '/tasks'],
      ['Report', '/reports'],
    ]);
  });

  it('evidenzia la voce corrispondente alla pagina aperta', () => {
    autentica();
    pathnameCorrente = '/reports';

    render(<AppShell />);

    const attiva = screen.getByRole('link', { name: 'Report' });
    expect(attiva.className).toContain('bg-white/15');
    expect(screen.getByRole('link', { name: 'Task' }).className).not.toContain('bg-white/15');
  });

  it('considera attiva la voce anche sulle pagine annidate', () => {
    // Il dettaglio di un report vive sotto /reports/:id: la voce "Report"
    // deve restare evidenziata.
    autentica();
    pathnameCorrente = '/reports/rep-1';

    render(<AppShell />);

    expect(screen.getByRole('link', { name: 'Report' }).className).toContain('bg-white/15');
  });

  it('non confonde due percorsi con lo stesso prefisso', () => {
    autentica();
    pathnameCorrente = '/runner';

    render(<AppShell />);

    expect(screen.getByRole('link', { name: 'Avvia' }).className).not.toContain('bg-white/15');
  });

  it('mostra nome e ruolo dell\'utente autenticato', () => {
    autentica('SECURITY_AUDITOR', 'Marco');

    render(<AppShell />);

    expect(screen.getByText('Marco')).toBeInTheDocument();
    expect(screen.getByText('Auditor')).toBeInTheDocument();
  });

  it('uscendo chiude la sessione e riporta al login', async () => {
    autentica();
    render(<AppShell />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Esci' }));

    expect(useSessionStore.getState().token).toBeNull();
    expect(useSessionStore.getState().user).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/login' });
  });

  it('senza utente in sessione non mostra il blocco profilo', () => {
    render(<AppShell />);

    expect(screen.queryByRole('button', { name: 'Esci' })).not.toBeInTheDocument();
  });

  it('renderizza il contenuto della pagina corrente', () => {
    autentica();

    render(<AppShell />);

    expect(screen.getByTestId('contenuto-pagina')).toBeInTheDocument();
  });

  it('mostra l\'avviso sulle credenziali solo quando risultano non valide', () => {
    autentica();
    const { rerender } = render(<AppShell />);
    expect(screen.queryByText(/Le credenziali non sono più valide/)).not.toBeInTheDocument();

    act(() => useSessionStore.setState({ credentialsStatus: 'invalid' }));
    rerender(<AppShell />);

    expect(screen.getByText(/Le credenziali non sono più valide/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aggiorna le credenziali' })).toHaveAttribute(
      'href',
      '/credentials',
    );
  });
});

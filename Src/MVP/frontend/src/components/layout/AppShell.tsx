import { Outlet, Link, useRouterState, useNavigate } from '@tanstack/react-router';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionStore } from '../../stores/sessionStore';
import { CredentialBanner } from './CredentialBanner';
import { RoleBadge } from './RoleBadge';

const NAV_LINKS = [
  { label: 'Credenziali', path: '/credentials' },
  { label: 'Repository',  path: '/select' },
  { label: 'Avvia',       path: '/run' },
  { label: 'Task',        path: '/tasks' },
  { label: 'Report',      path: '/reports' },
  { label: 'Template',    path: '/template' },
] as const;

export function AppShell() {
  useWebSocket();

  const user        = useSessionStore((s) => s.user);
  const logout      = useSessionStore((s) => s.logout);
  const navigate    = useNavigate();
  const routerState = useRouterState();
  const current     = routerState.location.pathname;

  function handle_logout() {
    logout();
    navigate({ to: '/login' });
  }

  return (
    <>
      <CredentialBanner />

      <div className="flex min-h-screen">
        {/* ---- Sidebar ---- */}
        <aside
          className="fixed top-0 left-0 flex h-screen w-[200px] flex-col bg-[#1e1e1e] text-white"
          aria-label="Navigazione principale"
        >
          <div className="flex h-14 items-center px-4 border-b border-white/10">
            <span className="text-base font-semibold tracking-wide">Code Guardian</span>
          </div>

          <nav className="flex-1 overflow-y-auto py-4">
            <ul className="flex flex-col gap-0.5 px-2">
              {NAV_LINKS.map(({ label, path }) => {
                const is_active = current === path || current.startsWith(path + '/');
                return (
                  <li key={path}>
                    <Link
                      to={path}
                      className={[
                        'flex items-center rounded px-3 py-2 text-sm transition',
                        is_active
                          ? 'bg-white/15 font-medium text-white'
                          : 'text-white/70 hover:bg-white/10 hover:text-white',
                      ].join(' ')}
                    >
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="border-t border-white/10 p-4">
            {user && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{user.firstName}</span>
                  <RoleBadge role={user.role} />
                </div>
                <button
                  onClick={handle_logout}
                  className="w-full rounded bg-white/10 px-3 py-1.5 text-xs text-white/80 hover:bg-white/20 transition text-left"
                >
                  Esci
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="ml-[200px] flex-1 overflow-y-auto bg-gray-50 p-6">
          <Outlet />
        </main>
      </div>
    </>
  );
}

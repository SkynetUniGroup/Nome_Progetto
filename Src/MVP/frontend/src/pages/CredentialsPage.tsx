import { useState, useEffect, type FormEvent } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { apiClient } from '../api/client';
import { ValidatedField } from '../components/shared/ValidatedField';
import { Spinner } from '../components/shared/Spinner';
import { StatusBadge } from '../components/shared/StatusBadge';
import type { CreateCredentialDto, ServiceCredentialDto } from '../types';

/**
 * CredentialsPage — /credentials
 *
 * Lets the user store the GitHub Personal Access Token the platform uses on
 * their behalf.
 *
 * The backend verifies the token against GitHub *before* persisting it, so
 * saving and validating are one step: a stored credential is by construction
 * one that worked. There is no separate "is it still valid?" flag to read —
 * only `connectedAt`, the moment it last checked out. The re-verify action
 * re-runs that check on demand.
 *
 * The token itself is never held here after submission: only the record the
 * backend returns, which contains no secret.
 */
export function CredentialsPage() {
  const set_status = useSessionStore((s) => s.setCredentialsStatus);
  const credentials_status = useSessionStore((s) => s.credentialsStatus);

  const [github_pat, setGithubPat] = useState('');
  const [errors, setErrors] = useState<{ github_pat?: string; global?: string }>({});
  const [saving, setSaving] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [fetch_loading, setFetchLoading] = useState(true);

  /** The stored GitHub credential, or null when none is configured. */
  const [credential, setCredential] = useState<ServiceCredentialDto | null>(null);

  /** Reads the stored credentials and derives the session-wide status. */
  async function load_credentials(): Promise<void> {
    try {
      const { data } = await apiClient.get<ServiceCredentialDto[]>('/credentials');
      const github = data.find((c) => c.provider === 'GITHUB') ?? null;
      setCredential(github);
      set_status(github ? 'connected' : 'missing');
    } catch {
      // A failed read is indistinguishable from "nothing stored yet" as far
      // as what the user can do next: configure a token.
      set_status('missing');
    }
  }

  useEffect(() => {
    void load_credentials().finally(() => setFetchLoading(false));
    // Runs once on mount: set_status comes from a Zustand store and is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Client-side check before spending a network round-trip. */
  function validate(): boolean {
    const next: typeof errors = {};
    const trimmed = github_pat.trim();
    if (!trimmed) {
      next.github_pat = 'Inserisci il GitHub PAT';
    } else if (!trimmed.startsWith('ghp_') && !trimmed.startsWith('github_pat_')) {
      next.github_pat = 'Il PAT GitHub deve iniziare con ghp_ oppure github_pat_';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handle_submit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    setErrors({});

    const dto: CreateCredentialDto = { provider: 'GITHUB', token: github_pat.trim() };

    try {
      const { data } = await apiClient.post<ServiceCredentialDto>('/credentials', dto);
      setCredential(data);
      set_status('connected');
      // Clear the field: the secret is stored server-side and must not stay
      // in the page any longer than the request needed it.
      setGithubPat('');
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 400) {
        set_status('invalid');
        setErrors({ global: 'GitHub ha rifiutato il token. Controllalo e riprova.' });
      } else {
        setErrors({ global: 'Errore durante il salvataggio. Riprova più tardi.' });
      }
    } finally {
      setSaving(false);
    }
  }

  /** Re-runs the GitHub check on the stored token. */
  async function handle_revalidate() {
    if (!credential) return;
    setRevalidating(true);
    setErrors({});
    try {
      const { data } = await apiClient.post<ServiceCredentialDto>(
        `/credentials/${credential.id}/validate`,
      );
      setCredential(data);
      set_status('connected');
    } catch {
      set_status('invalid');
      setErrors({ global: 'Il token memorizzato non è più valido. Inseriscine uno nuovo.' });
    } finally {
      setRevalidating(false);
    }
  }

  /** Formats an ISO-8601 instant for display, or a dash when absent. */
  function format_date(iso: string | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('it-IT', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-1 text-lg font-semibold text-[#2a2a2a]">Credenziali</h1>
      <p className="mb-6 text-sm text-gray-400">
        Il token viene verificato su GitHub e salvato cifrato sul server. Non viene mai esposto
        nel browser dopo il salvataggio.
      </p>

      {!fetch_loading && (
        <div className="mb-6 rounded-lg border border-[#cccccc] bg-gray-50 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Stato credenziali
          </p>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm text-gray-500">GitHub PAT:</span>
            {credentials_status === 'connected' && <StatusBadge status="COMPLETED" />}
            {credentials_status === 'invalid' && <StatusBadge status="FAILED" />}
            {(credentials_status === 'missing' || credentials_status === 'unknown') && (
              <StatusBadge status="PENDING" />
            )}
            <span className="text-xs text-gray-400">
              {credentials_status === 'connected' && 'Connessa e valida'}
              {credentials_status === 'invalid' && 'Non valida – aggiorna'}
              {credentials_status === 'missing' && 'Non configurata'}
              {credentials_status === 'unknown' && 'Verifica in corso…'}
            </span>
          </div>
          {credential && (
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-400">
                Ultima verifica: {format_date(credential.connectedAt)}
              </p>
              <button
                type="button"
                onClick={handle_revalidate}
                disabled={revalidating}
                className="text-xs text-[#2277cc] hover:underline disabled:opacity-50"
              >
                {revalidating ? 'Verifica in corso…' : 'Verifica di nuovo'}
              </button>
            </div>
          )}
        </div>
      )}

      {errors.global && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-[#cc2222]">
          {errors.global}
        </div>
      )}

      {credentials_status === 'connected' && !saving && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-[#2a8a2a]">
          Credenziali salvate e verificate. Puoi procedere a scegliere un repository.
        </div>
      )}

      <form onSubmit={handle_submit} noValidate className="flex flex-col gap-5">
        <div>
          <ValidatedField
            label="GitHub Personal Access Token"
            type="password"
            autoComplete="off"
            placeholder="ghp_xxxxxxxxxxxx"
            value={github_pat}
            onChange={(e) => {
              setGithubPat(e.target.value);
              setErrors((p) => ({ ...p, github_pat: undefined }));
            }}
            error={errors.github_pat}
          />
          <p className="mt-1 text-xs text-gray-400">
            Richiede i permessi di scrittura sul repository: il sistema crea branch e apre Pull
            Request. Genera un token su{' '}
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noreferrer"
              className="text-[#2277cc] hover:underline"
            >
              github.com/settings/tokens
            </a>
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="flex items-center justify-center gap-2 rounded bg-[#2a2a2a] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#111] transition disabled:opacity-60"
        >
          {saving && <Spinner size="sm" className="text-white" />}
          {saving ? 'Verifica in corso…' : 'Salva e verifica'}
        </button>
      </form>
    </div>
  );
}

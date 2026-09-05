import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { apiClient } from '../api/client';
import { useSelectionStore } from '../stores/selectionStore';
import { ValidatedField } from '../components/shared/ValidatedField';
import { Spinner } from '../components/shared/Spinner';
import { ErrorState } from '../components/shared/ErrorState';
import type { Repository, CreateContextDto, AnalysisContextDto } from '../types';

/**
 * SelectPage — /select
 *
 * Allows the user to choose a GitHub repository and configure the analysis
 * context (branch/ref, scope type, paths).
 *
 * Flow:
 *  1. Fetches the list of accessible repositories from GET /repositories.
 *  2. User selects a repo, branch, and scope type (FULL_REPOSITORY | FILES | DIRECTORIES).
 *  3. When scopeType is FILES or DIRECTORIES the user can enter specific paths.
 *  4. On submit, POSTs to POST /contexts; the returned AnalysisContextDto is
 *     stored in selectionStore so /run can consume it without a second API call.
 *  5. Redirects to /run.
 */
export function SelectPage() {
  const navigate = useNavigate();
  const setContext = useSelectionStore((s) => s.setContext);

  // Repository list state
  const [repos, setRepos] = useState<Repository[]>([]);
  const [repos_loading, setReposLoading] = useState(true);
  const [repos_error, setReposError] = useState('');

  // Form state
  const [selected_repo, setSelectedRepo] = useState<Repository | null>(null);
  const [ref, setRef] = useState('');
  const [scope_type, setScopeType] = useState<CreateContextDto['scopeType']>('FULL_REPOSITORY');
  const [paths_text, setPathsText] = useState('');
  const [form_errors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submit_error, setSubmitError] = useState('');

  // Fetch repositories on mount.
  useEffect(() => {
    async function fetch_repos() {
      try {
        const response = await apiClient.get<Repository[]>('/repositories');
        setRepos(response.data);
      } catch {
        setReposError(
          'Impossibile caricare i repository. Verifica che le credenziali GitHub siano valide.',
        );
      } finally {
        setReposLoading(false);
      }
    }
    fetch_repos();
  }, []);

  // When the user selects a repo, pre-fill the ref with its default branch.
  function handle_repo_change(owner_name: string) {
    const repo = repos.find((r) => `${r.owner}/${r.name}` === owner_name) ?? null;
    setSelectedRepo(repo);
    setRef(repo?.defaultBranch ?? '');
  }

  /** Client-side validation. */
  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!selected_repo) next.repo = 'Seleziona un repository';
    if (!ref.trim()) next.ref = 'Inserisci il branch o il commit SHA';
    if (scope_type !== 'FULL_REPOSITORY' && !paths_text.trim()) {
      next.paths = 'Inserisci almeno un percorso';
    }
    setFormErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handle_submit(e: FormEvent) {
    e.preventDefault();
    if (!validate() || !selected_repo) return;

    setSubmitting(true);
    setSubmitError('');

    // Convert newline-separated paths to an array, filtering blank lines.
    const paths_array = paths_text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    // The backend identifies the repository by its URL, not by owner/name,
    // and validates it against a GitHub URL pattern.
    const dto: CreateContextDto = {
      repoUrl: `https://github.com/${selected_repo.owner}/${selected_repo.name}`,
      branch: ref.trim(),
      scopeType: scope_type,
      ...(paths_array.length > 0 ? { paths: paths_array } : {}),
    };

    try {
      const response = await apiClient.post<AnalysisContextDto>('/contexts', dto);
      // Store the full context DTO so /run can read repo metadata without
      // an additional API round-trip.
      setContext(response.data);
      navigate({ to: '/run' });
    } catch {
      setSubmitError(
        'Impossibile salvare il contesto. Verifica i parametri e riprova.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render ----

  if (repos_loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm">
        <Spinner size="sm" />
        Caricamento repository…
      </div>
    );
  }

  if (repos_error) {
    return (
      <ErrorState
        message={repos_error}
        action={
          <button
            onClick={() => window.location.reload()}
            className="rounded border border-[#cccccc] px-3 py-1.5 text-sm text-[#2a2a2a] hover:bg-gray-50"
          >
            Riprova
          </button>
        }
      />
    );
  }

  /** Whether the current scope type requires explicit paths input. */
  const requires_paths = scope_type !== 'FULL_REPOSITORY';

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-1 text-lg font-semibold text-[#2a2a2a]">Seleziona Repository</h1>
      <p className="mb-6 text-sm text-gray-400">
        Configura il contesto di analisi: scegli il repository, il branch e il tipo di scope.
      </p>

      {submit_error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-[#cc2222]">
          {submit_error}
        </div>
      )}

      <form onSubmit={handle_submit} noValidate className="flex flex-col gap-5">
        {/* Repository selector */}
        <div className="flex flex-col gap-1">
          <label htmlFor="repo-select" className="text-sm font-medium text-[#2a2a2a]">
            Repository
          </label>
          <select
            id="repo-select"
            value={selected_repo ? `${selected_repo.owner}/${selected_repo.name}` : ''}
            onChange={(e) => {
              handle_repo_change(e.target.value);
              setFormErrors((p) => ({ ...p, repo: '' }));
            }}
            className="w-full rounded border border-[#cccccc] bg-white px-3 py-2 text-sm text-[#2a2a2a] outline-none focus:border-[#2277cc] focus:ring-2 focus:ring-[#2277cc]/20"
          >
            <option value="">-- Seleziona un repository --</option>
            {repos.map((r) => (
              <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
                {r.owner}/{r.name} {r.private ? '🔒' : ''}
              </option>
            ))}
          </select>
          {form_errors.repo && (
            <span className="text-xs text-[#cc2222]">{form_errors.repo}</span>
          )}
        </div>

        {/* Branch / ref */}
        <ValidatedField
          label="Branch o Commit SHA"
          placeholder="main"
          value={ref}
          onChange={(e) => {
            setRef(e.target.value);
            setFormErrors((p) => ({ ...p, ref: '' }));
          }}
          error={form_errors.ref}
        />

        {/* Scope type selector */}
        <div className="flex flex-col gap-1">
          <label htmlFor="scope-type" className="text-sm font-medium text-[#2a2a2a]">
            Tipo di scope
          </label>
          <select
            id="scope-type"
            value={scope_type}
            onChange={(e) => {
              setScopeType(e.target.value as CreateContextDto['scopeType']);
              setPathsText('');
              setFormErrors((p) => ({ ...p, paths: '' }));
            }}
            className="w-full rounded border border-[#cccccc] bg-white px-3 py-2 text-sm text-[#2a2a2a] outline-none focus:border-[#2277cc] focus:ring-2 focus:ring-[#2277cc]/20"
          >
            <option value="FULL_REPOSITORY">Repository completo</option>
            <option value="FILES">File specifici</option>
            <option value="DIRECTORIES">Directory specifiche</option>
          </select>
          <p className="text-xs text-gray-400">
            {scope_type === 'FULL_REPOSITORY' && 'Tutti i file del repository verranno inclusi nell\'analisi.'}
            {scope_type === 'FILES' && 'Specifica i file esatti da analizzare (uno per riga).'}
            {scope_type === 'DIRECTORIES' && 'Specifica le directory da analizzare (una per riga).'}
          </p>
        </div>

        {/* Paths input — shown only when scope type requires it */}
        {requires_paths && (
          <div className="flex flex-col gap-1">
            <label htmlFor="paths-input" className="text-sm font-medium text-[#2a2a2a]">
              {scope_type === 'FILES' ? 'File da analizzare' : 'Directory da analizzare'}
            </label>
            <textarea
              id="paths-input"
              rows={5}
              placeholder={
                scope_type === 'FILES'
                  ? 'src/controllers/auth.ts\nsrc/models/user.ts'
                  : 'src/controllers\nsrc/models'
              }
              value={paths_text}
              onChange={(e) => {
                setPathsText(e.target.value);
                setFormErrors((p) => ({ ...p, paths: '' }));
              }}
              className="w-full rounded border border-[#cccccc] bg-white px-3 py-2 text-sm font-mono text-[#2a2a2a] outline-none focus:border-[#2277cc] focus:ring-2 focus:ring-[#2277cc]/20 resize-y"
            />
            <p className="text-xs text-gray-400">Un percorso per riga, relativo alla radice del repository.</p>
            {form_errors.paths && (
              <span className="text-xs text-[#cc2222]">{form_errors.paths}</span>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="flex items-center justify-center gap-2 rounded bg-[#2a2a2a] px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-200 transition disabled:opacity-60"
        >
          {submitting && <Spinner size="sm" className="text-white" />}
          Salva contesto e vai ad Avvia
        </button>
      </form>
    </div>
  );
}

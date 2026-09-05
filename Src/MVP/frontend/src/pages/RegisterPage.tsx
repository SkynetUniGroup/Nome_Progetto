import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSessionStore } from '../stores/sessionStore';
import { apiClient } from '../api/client';
import { ValidatedField } from '../components/shared/ValidatedField';
import { Spinner } from '../components/shared/Spinner';
import type { RegisterDto, AuthTokenDto, UserProfileDto, UserRole } from '../types';

/** Role options shown in the register form selector. */
const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'DEVELOPER', label: 'Developer' },
  { value: 'SECURITY_AUDITOR', label: 'Security Auditor' },
  { value: 'PROJECT_MANAGER', label: 'Project Manager' },
];

/**
 * RegisterPage — /register
 *
 * New-user registration form. On success, the user is immediately logged in
 * (the backend returns a JWT) and redirected to /credentials so they can
 * set up their GitHub PAT and OpenAI key before using the platform.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const login = useSessionStore((s) => s.login);

  // Form fields
  const [first_name, setFirstName] = useState('');
  const [last_name, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm_password, setConfirmPassword] = useState('');
  const [role, setRole] = useState<UserRole>('DEVELOPER');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  /** Client-side validation before the API call. */
  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!first_name.trim()) next.first_name = 'Inserisci il nome';
    if (!last_name.trim()) next.last_name = 'Inserisci il cognome';
    if (!email.trim()) next.email = 'Inserisci la email';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = 'Email non valida';
    if (password.length < 8) next.password = 'La password deve essere di almeno 8 caratteri';
    if (password !== confirm_password) next.confirm_password = 'Le password non coincidono';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handle_submit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setErrors({});

    const dto: RegisterDto = {
      firstName: first_name.trim(),
      lastName: last_name.trim(),
      email: email.trim(),
      password,
      role,
    };

    try {
      // Registration returns the profile but no token: the account exists,
      // the session does not yet. Logging in right after spares the user a
      // second form with credentials they just typed.
      const profile = await apiClient.post<UserProfileDto>('/auth/register', dto);
      const { data } = await apiClient.post<AuthTokenDto>('/auth/login', {
        email: dto.email,
        password: dto.password,
      });
      login(profile.data, data.accessToken);
      // Redirect to /credentials so the user sets up their secrets immediately.
      navigate({ to: '/credentials' });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 409) {
        setErrors({ global: 'Esiste già un account con questa email.' });
      } else {
        setErrors({ global: 'Errore durante la registrazione. Riprova.' });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-[#cccccc] bg-gray-50 p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-[#2a2a2a]">Code Guardian</h1>
        <p className="mb-6 text-sm text-gray-400">Crea il tuo account</p>

        {errors.global && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-[#cc2222]">
            {errors.global}
          </div>
        )}

        <form onSubmit={handle_submit} noValidate className="flex flex-col gap-4">
          {/* Name row */}
          <div className="flex gap-3">
            <ValidatedField
              label="Nome"
              placeholder="Marco"
              value={first_name}
              onChange={(e) => { setFirstName(e.target.value); setErrors((p) => ({ ...p, first_name: '' })); }}
              error={errors.first_name}
              containerClassName="flex-1"
            />
            <ValidatedField
              label="Cognome"
              placeholder="Rossi"
              value={last_name}
              onChange={(e) => { setLastName(e.target.value); setErrors((p) => ({ ...p, last_name: '' })); }}
              error={errors.last_name}
              containerClassName="flex-1"
            />
          </div>

          <ValidatedField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="nome@azienda.it"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: '' })); }}
            error={errors.email}
          />

          {/* Role selector */}
          <div className="flex flex-col gap-1">
            <label htmlFor="role-select" className="text-sm font-medium text-[#2a2a2a]">
              Ruolo
            </label>
            <select
              id="role-select"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full rounded border border-[#cccccc] bg-white px-3 py-2 text-sm text-[#2a2a2a] outline-none focus:border-[#2277cc] focus:ring-2 focus:ring-[#2277cc]/20"
            >
              {ROLE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <ValidatedField
            label="Password"
            type="password"
            autoComplete="new-password"
            placeholder="Minimo 8 caratteri"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: '' })); }}
            error={errors.password}
          />

          <ValidatedField
            label="Conferma Password"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••"
            value={confirm_password}
            onChange={(e) => { setConfirmPassword(e.target.value); setErrors((p) => ({ ...p, confirm_password: '' })); }}
            error={errors.confirm_password}
          />

          <button
            type="submit"
            disabled={loading}
            className="mt-2 flex items-center justify-center gap-2 rounded bg-[#2a2a2a] px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-200 transition disabled:opacity-60"
          >
            {loading && <Spinner size="sm" className="text-white" />}
            Registrati
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-500">
          Hai già un account?{' '}
          <Link to="/login" className="text-[#2277cc] hover:underline">
            Accedi
          </Link>
        </p>
      </div>
    </div>
  );
}

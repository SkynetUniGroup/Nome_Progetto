import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSessionStore } from '../stores/sessionStore';
import { apiClient } from '../api/client';
import { ValidatedField } from '../components/shared/ValidatedField';
import { Spinner } from '../components/shared/Spinner';
import type { LoginDto, AuthTokenDto, UserProfileDto } from '../types';

export function LoginPage() {
  const navigate = useNavigate();
  const login = useSessionStore((s) => s.login);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; global?: string }>({});
  const [loading, setLoading] = useState(false);

  function validate(): boolean {
    const next: typeof errors = {};
    if (!email.trim()) next.email = 'Inserisci la tua email';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = 'Email non valida';
    if (!password) next.password = 'Inserisci la password';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handle_submit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setErrors({});
    const dto: LoginDto = { email: email.trim(), password };
    try {
      const { data } = await apiClient.post<AuthTokenDto>('/auth/login', dto);
      // The login response carries the token alone. The profile comes from
      // /auth/me, called with the fresh token passed explicitly: the request
      // interceptor reads the store, which has not been updated yet.
      const profile = await apiClient.get<UserProfileDto>('/auth/me', {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      });
      login(profile.data, data.accessToken);
      navigate({ to: '/select' });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        setErrors({ global: 'Email o password non corretti.' });
      } else {
        setErrors({ global: 'Errore di rete. Riprova più tardi.' });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-[#cccccc] bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-[#2a2a2a]">Code Guardian</h1>
        <p className="mb-6 text-sm text-gray-500">Accedi al tuo account</p>

        {errors.global && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-[#cc2222]">
            {errors.global}
          </div>
        )}

        <form onSubmit={handle_submit} noValidate className="flex flex-col gap-4">
          <ValidatedField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="nome@azienda.it"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: undefined })); }}
            error={errors.email}
          />
          <ValidatedField
            label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: undefined })); }}
            error={errors.password}
          />
          <button
            type="submit"
            disabled={loading}
            className="mt-2 flex items-center justify-center gap-2 rounded bg-[#2a2a2a] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#111] transition disabled:opacity-60"
          >
            {loading && <Spinner size="sm" className="text-white" />}
            Accedi
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-500">
          Non hai un account?{' '}
          <Link to="/register" className="text-[#2277cc] hover:underline">
            Registrati
          </Link>
        </p>
      </div>
    </div>
  );
}

import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Helper condivisi dai Test di Sistema e di Accettazione.
 *
 * I test verificano il comportamento dell'applicazione dal browser, ma la
 * *preparazione* dello stato (un utente che esiste, una credenziale salvata,
 * un contesto creato) passa dalle API: ripetere ogni volta l'intero flusso a
 * mano renderebbe ogni test una copia del precedente e ne nasconderebbe
 * l'oggetto.
 */

export const API = 'http://localhost:3000/api/v1';

/** PAT reale, letto dall'ambiente: i test che ne hanno bisogno si skippano senza. */
export const GITHUB_PAT = process.env.E2E_GITHUB_PAT ?? '';

/** Repository pubblico usato come bersaglio delle analisi. */
export const REPO = {
  url: 'https://github.com/OWASP/NodeGoat',
  owner: 'OWASP',
  name: 'NodeGoat',
  branch: 'master',
};

export interface Utente {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  role: 'DEVELOPER' | 'SECURITY_AUDITOR' | 'PROJECT_MANAGER';
}

/**
 * Genera credenziali uniche.
 * I test condividono lo stesso database: un'email fissa farebbe fallire la
 * seconda registrazione con un 409 legittimo.
 */
export function nuovoUtente(role: Utente['role'] = 'DEVELOPER'): Utente {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `e2e-${id}@esempio.invalid`,
    password: 'password-di-prova-123',
    role,
  };
}

/** Registra l'utente via API e restituisce il token di una sessione aperta. */
export async function registraEAccedi(
  request: APIRequestContext,
  utente: Utente = nuovoUtente(),
): Promise<{ utente: Utente; token: string }> {
  const registrazione = await request.post(`${API}/auth/register`, { data: utente });
  expect(registrazione.ok()).toBeTruthy();

  const login = await request.post(`${API}/auth/login`, {
    data: { email: utente.email, password: utente.password },
  });
  expect(login.ok()).toBeTruthy();

  const { accessToken } = await login.json();
  return { utente, token: accessToken };
}

/** Intestazioni di una richiesta autenticata. */
export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Salva il PAT GitHub dell'utente. Il backend lo verifica prima di persisterlo. */
export async function salvaCredenziale(
  request: APIRequestContext,
  token: string,
  pat: string = GITHUB_PAT,
): Promise<string> {
  const risposta = await request.post(`${API}/credentials`, {
    headers: auth(token),
    data: { provider: 'GITHUB', token: pat },
  });
  if (!risposta.ok()) {
    throw new Error(
      `Il PAT non è utilizzabile: ${risposta.status()} ${await risposta.text()}. ` +
        'Serve un token con lo scope "repo" (il sistema crea branch e apre Pull Request).',
    );
  }
  return (await risposta.json()).id;
}

/**
 * Verifica una sola volta che il PAT configurato sia davvero spendibile.
 *
 * Un token sintatticamente valido ma privo dello scope `repo` viene
 * rifiutato dal backend: senza questo controllo ogni test dipendente da
 * GitHub fallirebbe separatamente, nascondendo l'unica causa comune dietro
 * venti errori diversi.
 */
let patUtilizzabile: boolean | null = null;

export async function patSpendibile(request: APIRequestContext): Promise<boolean> {
  if (patUtilizzabile !== null) return patUtilizzabile;
  if (!GITHUB_PAT) {
    patUtilizzabile = false;
    return false;
  }
  const { token } = await registraEAccedi(request);
  const risposta = await request.post(`${API}/credentials`, {
    headers: auth(token),
    data: { provider: 'GITHUB', token: GITHUB_PAT },
  });
  patUtilizzabile = risposta.ok();
  return patUtilizzabile;
}

/** Crea un contesto di analisi e ne restituisce l'identificativo. */
export async function creaContesto(
  request: APIRequestContext,
  token: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const risposta = await request.post(`${API}/contexts`, {
    headers: auth(token),
    data: {
      repoUrl: REPO.url,
      branch: REPO.branch,
      scopeType: 'FULL_REPOSITORY',
      ...over,
    },
  });
  expect(risposta.ok()).toBeTruthy();
  return (await risposta.json()).id;
}

/**
 * Porta il browser in una sessione autenticata senza passare dal modulo di
 * login, per i test il cui oggetto non e' l'autenticazione.
 *
 * Il token vive solo in memoria (requisito di sicurezza: sparisce al
 * refresh), quindi va iniettato nello store prima che l'app monti — da qui
 * l'addInitScript invece di una scrittura in localStorage.
 */
export async function sessioneAperta(page: Page, token: string, profilo: unknown) {
  await page.addInitScript(
    ([t, p]) => {
      (window as any).__E2E_SESSION__ = { token: t, user: p };
    },
    [token, profilo] as const,
  );
}

/** Attende che una task raggiunga uno stato terminale nella dashboard. */
export async function attendiEsito(page: Page, timeout = 120_000) {
  await expect(
    page.getByText(/Completato|Fallito|Annullato/).first(),
  ).toBeVisible({ timeout });
}

/** Esegue il login dal modulo, come farebbe l'utente. */
export async function accediDalModulo(page: Page, utente: Utente) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(utente.email);
  await page.getByLabel('Password').fill(utente.password);
  await page.getByRole('button', { name: 'Accedi' }).click();
  await expect(page).toHaveURL(/\/select$/);
}

/** Voci della barra di navigazione dell'area autenticata. */
export type Sezione = 'Credenziali' | 'Repository' | 'Avvia' | 'Task' | 'Report';

/**
 * Naviga verso una sezione usando la barra laterale.
 *
 * Necessario: il token vive solo in memoria — requisito di sicurezza, sparisce
 * al refresh — quindi un `page.goto()` dopo il login chiude la sessione e fa
 * scattare la guardia di rotta verso /login. Dentro l'area autenticata ci si
 * sposta come fa l'utente, cliccando.
 */
export async function vaiA(page: Page, sezione: Sezione) {
  await page.getByRole('link', { name: sezione, exact: true }).click();
}

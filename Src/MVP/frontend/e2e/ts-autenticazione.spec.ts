import { test, expect } from '@playwright/test';
import { nuovoUtente, registraEAccedi, accediDalModulo, vaiA, API } from './helpers';

/**
 * Test di Sistema TS_1 – TS_9 (RF.1 – RF.9): registrazione e autenticazione.
 *
 * Girano nel browser contro lo stack reale. Non serve alcun token esterno:
 * l'intero blocco tocca solo backend e MongoDB.
 */

test.describe('TS_1–TS_9 · Registrazione e autenticazione', () => {
  test('TS_1 (RF.1) — un utente non registrato completa la registrazione', async ({ page }) => {
    const utente = nuovoUtente();
    await page.goto('/register');

    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);
    await page.getByRole('button', { name: 'Registrati' }).click();

    // La registrazione apre la sessione e porta alla configurazione delle
    // credenziali, che e' il passo successivo obbligato.
    await expect(page).toHaveURL(/\/credentials$/);
  });

  test('TS_2 (RF.2) — il nome è un campo obbligatorio della registrazione', async ({ page }) => {
    const utente = nuovoUtente();
    await page.goto('/register');

    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);
    await page.getByRole('button', { name: 'Registrati' }).click();

    await expect(page.getByText('Inserisci il nome')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('TS_3 (RF.3) — il cognome è un campo obbligatorio della registrazione', async ({ page }) => {
    const utente = nuovoUtente();
    await page.goto('/register');

    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);
    await page.getByRole('button', { name: 'Registrati' }).click();

    await expect(page.getByText('Inserisci il cognome')).toBeVisible();
  });

  test('TS_4 (RF.4) — l\'email viene richiesta e validata nel formato', async ({ page }) => {
    const utente = nuovoUtente();
    await page.goto('/register');
    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);

    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('Inserisci la email')).toBeVisible();

    await page.getByLabel('Email').fill('non-e-una-email');
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('Email non valida')).toBeVisible();
  });

  test('TS_5 (RF.5) — la password richiede una lunghezza minima e una conferma', async ({ page }) => {
    const utente = nuovoUtente();
    await page.goto('/register');
    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Email').fill(utente.email);

    await page.getByLabel('Password', { exact: true }).fill('corta');
    await page.getByLabel('Conferma Password').fill('corta');
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('La password deve essere di almeno 8 caratteri')).toBeVisible();

    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill('password-diversa');
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('Le password non coincidono')).toBeVisible();
  });

  test('TS_6 (RF.6) — un\'email già registrata viene rifiutata', async ({ page, request }) => {
    const { utente } = await registraEAccedi(request);
    await page.goto('/register');

    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);
    await page.getByRole('button', { name: 'Registrati' }).click();

    await expect(page.getByText('Esiste già un account con questa email.')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('TS_7 (RF.7) — il ruolo scelto determina le operazioni sbloccate', async ({ page, request }) => {
    // Il ruolo viaggia nel token e decide cosa l'utente puo' avviare:
    // un Security Auditor non vede le operazioni di documentazione.
    const { utente } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await accediDalModulo(page, utente);

    await vaiA(page, 'Avvia');
    await expect(page.getByText('Auditor')).toBeVisible();
  });

  test('TS_8 (RF.8) — l\'utente si autentica con email e password', async ({ page, request }) => {
    const { utente } = await registraEAccedi(request);

    await page.goto('/login');
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password').fill(utente.password);
    await page.getByRole('button', { name: 'Accedi' }).click();

    await expect(page).toHaveURL(/\/select$/);
    await expect(page.getByRole('button', { name: 'Esci' })).toBeVisible();
  });

  test('TS_9 (RF.9) — credenziali errate producono un errore generico', async ({ page, request }) => {
    const { utente } = await registraEAccedi(request);

    // Password sbagliata su un account esistente.
    await page.goto('/login');
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password').fill('password-sbagliata');
    await page.getByRole('button', { name: 'Accedi' }).click();
    const messaggioPasswordErrata = await page
      .getByText('Email o password non corretti.')
      .textContent();

    // Account inesistente: il messaggio deve essere identico, altrimenti
    // basterebbe confrontarli per enumerare gli account registrati.
    await page.goto('/login');
    await page.getByLabel('Email').fill('mai-registrato@esempio.invalid');
    await page.getByLabel('Password').fill('password-qualsiasi');
    await page.getByRole('button', { name: 'Accedi' }).click();
    const messaggioUtenteIgnoto = await page
      .getByText('Email o password non corretti.')
      .textContent();

    expect(messaggioUtenteIgnoto).toBe(messaggioPasswordErrata);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('TS_9b (RF.9) — il backend non distingue i due casi nemmeno nel codice di stato', async ({
    request,
  }) => {
    const { utente } = await registraEAccedi(request);

    const passwordErrata = await request.post(`${API}/auth/login`, {
      data: { email: utente.email, password: 'sbagliata' },
    });
    const utenteIgnoto = await request.post(`${API}/auth/login`, {
      data: { email: 'mai-visto@esempio.invalid', password: 'sbagliata' },
    });

    expect(utenteIgnoto.status()).toBe(passwordErrata.status());
    expect(utenteIgnoto.status()).toBe(401);
  });
});

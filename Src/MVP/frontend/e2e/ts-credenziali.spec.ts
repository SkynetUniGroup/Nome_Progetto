import { test, expect } from '@playwright/test';
import {
  vaiA,
  registraEAccedi,
  accediDalModulo,
  salvaCredenziale,
  patSpendibile,
  GITHUB_PAT,
  API,
  auth,
} from './helpers';

/**
 * Test di Sistema TS_10, TS_11, TS_13, TS_14 (RF.10, RF.11, RF.13, RF.14):
 * configurazione delle credenziali per i servizi esterni.
 *
 * TS_12 (RF.12, token del sistema di Task Management) non è verificabile:
 * l'unico provider previsto dal backend è GITHUB.
 */

test.describe('TS_10–TS_14 · Credenziali dei servizi esterni', () => {
  test('TS_14 (RF.14) — un PAT dal formato non valido viene rifiutato senza contattare GitHub', async ({
    page,
    request,
  }) => {
    const { utente } = await registraEAccedi(request);
    await accediDalModulo(page, utente);
    await vaiA(page, 'Credenziali');

    let chiamate = 0;
    await page.route('**/api/v1/credentials', (route) => {
      if (route.request().method() === 'POST') chiamate += 1;
      return route.continue();
    });

    await page.getByLabel('GitHub Personal Access Token').fill('token-inventato');
    await page.getByRole('button', { name: /Salva e verifica/ }).click();

    await expect(
      page.getByText('Il PAT GitHub deve iniziare con ghp_ oppure github_pat_'),
    ).toBeVisible();
    expect(chiamate).toBe(0);
  });

  test('TS_14b (RF.14) — il campo vuoto viene segnalato', async ({ page, request }) => {
    const { utente } = await registraEAccedi(request);
    await accediDalModulo(page, utente);
    await vaiA(page, 'Credenziali');

    await page.getByRole('button', { name: /Salva e verifica/ }).click();

    await expect(page.getByText('Inserisci il GitHub PAT')).toBeVisible();
  });

  test('TS_13 (RF.13) — un token sintatticamente valido ma rifiutato da GitHub non viene memorizzato', async ({
    page,
    request,
  }) => {
    // Il formato è corretto, quindi la validazione locale lo lascia passare:
    // a bocciarlo è la chiamata reale a GitHub fatta dal backend.
    const { utente } = await registraEAccedi(request);
    await accediDalModulo(page, utente);
    await vaiA(page, 'Credenziali');

    await page.getByLabel('GitHub Personal Access Token').fill('ghp_token_inesistente_0000000000');
    await page.getByRole('button', { name: /Salva e verifica/ }).click();

    await expect(page.getByText(/GitHub ha rifiutato il token/)).toBeVisible();
    await expect(page.getByText('Non valida – aggiorna')).toBeVisible();
  });

  test('TS_13b (RF.13) — il token rifiutato non finisce nell\'archivio credenziali', async ({
    request,
  }) => {
    const { token } = await registraEAccedi(request);

    const salvataggio = await request.post(`${API}/credentials`, {
      headers: auth(token),
      data: { provider: 'GITHUB', token: 'ghp_token_inesistente_0000000000' },
    });
    expect(salvataggio.ok()).toBeFalsy();

    const elenco = await request.get(`${API}/credentials`, { headers: auth(token) });
    expect(await elenco.json()).toEqual([]);
  });

  test.describe('con un PAT reale', () => {
    test.beforeAll(async ({ request }) => {
      test.skip(
        !(await patSpendibile(request)),
        'richiede un E2E_GITHUB_PAT con lo scope "repo"',
      );
    });

    test('TS_11 (RF.11) — l\'utente inserisce il proprio PAT GitHub', async ({ page, request }) => {
      const { utente } = await registraEAccedi(request);
      await accediDalModulo(page, utente);
      await vaiA(page, 'Credenziali');

      await page.getByLabel('GitHub Personal Access Token').fill(GITHUB_PAT);
      await page.getByRole('button', { name: /Salva e verifica/ }).click();

      await expect(page.getByText('Connessa e valida')).toBeVisible();
    });

    test('TS_10 (RF.10) — il token viene memorizzato e sopravvive alla riapertura della pagina', async ({
      page,
      request,
    }) => {
      const { utente } = await registraEAccedi(request);
      await accediDalModulo(page, utente);
      await vaiA(page, 'Credenziali');
      await page.getByLabel('GitHub Personal Access Token').fill(GITHUB_PAT);
      await page.getByRole('button', { name: /Salva e verifica/ }).click();
      await expect(page.getByText('Connessa e valida')).toBeVisible();

      await vaiA(page, 'Credenziali');

      await expect(page.getByText('Connessa e valida')).toBeVisible();
      await expect(page.getByText(/Ultima verifica:/)).toBeVisible();
    });

    test('TS_10b (RF.10) — il segreto non è più esposto nel browser dopo il salvataggio', async ({
      page,
      request,
    }) => {
      const { utente } = await registraEAccedi(request);
      await accediDalModulo(page, utente);
      await vaiA(page, 'Credenziali');
      await page.getByLabel('GitHub Personal Access Token').fill(GITHUB_PAT);
      await page.getByRole('button', { name: /Salva e verifica/ }).click();
      await expect(page.getByText('Connessa e valida')).toBeVisible();

      // Il campo viene svuotato e il token non compare da nessuna parte
      // nella pagina né nelle Web Storage.
      await expect(page.getByLabel('GitHub Personal Access Token')).toHaveValue('');
      const contenuto = await page.content();
      expect(contenuto).not.toContain(GITHUB_PAT);
      const storage = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      );
      expect(storage).not.toContain(GITHUB_PAT);
    });

    test('TS_10c (RF.10) — l\'archivio credenziali non restituisce mai il token', async ({
      request,
    }) => {
      const { token } = await registraEAccedi(request);
      await salvaCredenziale(request, token);

      const elenco = await request.get(`${API}/credentials`, { headers: auth(token) });
      const credenziali = await elenco.json();

      // Prima che l'assenza del token significhi qualcosa, la credenziale
      // deve esserci davvero: su un elenco vuoto l'asserzione passerebbe
      // per definizione.
      expect(credenziali).toHaveLength(1);
      expect(JSON.stringify(credenziali)).not.toContain(GITHUB_PAT);
    });

    test('TS_13c (RF.13) — la credenziale memorizzata può essere riverificata su richiesta', async ({
      page,
      request,
    }) => {
      const { utente } = await registraEAccedi(request);
      await accediDalModulo(page, utente);
      await vaiA(page, 'Credenziali');
      await page.getByLabel('GitHub Personal Access Token').fill(GITHUB_PAT);
      await page.getByRole('button', { name: /Salva e verifica/ }).click();
      await expect(page.getByText('Connessa e valida')).toBeVisible();

      await page.getByRole('button', { name: /Verifica di nuovo/ }).click();

      await expect(page.getByText('Connessa e valida')).toBeVisible();
    });
  });
});

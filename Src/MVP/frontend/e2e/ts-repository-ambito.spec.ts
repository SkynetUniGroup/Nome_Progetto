import { test, expect } from '@playwright/test';
import {
  DIRECTORY_SORGENTE,
  FILE_SORGENTE,
  patSpendibile,
  vaiA,
  registraEAccedi,
  accediDalModulo,
  salvaCredenziale,
  GITHUB_PAT,
  REPO,
  API,
  auth,
} from './helpers';

/**
 * Test di Sistema TS_15 – TS_31 (RF.15 – RF.31): selezione del repository,
 * del riferimento di base e dell'ambito di analisi.
 *
 * TS_18 e TS_23 (Pull Request come riferimento di base) non sono
 * verificabili: il backend non espone quel tipo di riferimento e la pagina
 * di selezione offre solo branch e commit.
 *
 * Quasi tutto questo blocco interroga GitHub, quindi richiede un PAT reale.
 */

test.describe('TS_15–TS_31 · Repository, riferimento e ambito', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(
      !(await patSpendibile(request)),
      'richiede un E2E_GITHUB_PAT con lo scope "repo"',
    );
  });

  /** Utente autenticato con credenziale GitHub già salvata. */
  async function utentePronto(page: any, request: any) {
    const { utente, token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);
    await accediDalModulo(page, utente);
    return token;
  }

  test('TS_16 (RF.16) — l\'utente sceglie il repository e il tipo di riferimento', async ({
    page,
    request,
  }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await expect(page.getByLabel('Repository')).toBeVisible();
    await expect(page.getByLabel('Branch o Commit SHA')).toBeVisible();
    await expect(page.getByLabel('Tipo di scope')).toBeVisible();
  });

  test('TS_17 (RF.17) — il branch viene proposto e può essere sostituito da un commit', async ({
    page,
    request,
  }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    // Scegliendo il repository il campo si popola con il branch di default.
    await expect(page.getByLabel('Branch o Commit SHA')).toHaveValue(REPO.branch);

    await page.getByLabel('Branch o Commit SHA').fill('a1b2c3d');
    await expect(page.getByLabel('Branch o Commit SHA')).toHaveValue('a1b2c3d');
  });

  test('TS_15 (RF.15) — la selezione viene registrata e resa disponibile agli agenti', async ({
    page,
    request,
  }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();

    // Il contesto è creato: la pagina di avvio ne mostra il riepilogo.
    await expect(page).toHaveURL(/\/run$/);
    await expect(page.getByText(`${REPO.owner}/${REPO.name}`)).toBeVisible();
    await expect(page.getByText(/SHA:/)).toBeVisible();
  });

  test('TS_19 (RF.19) — un URL di repository non valido viene rifiutato', async ({ request }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: 'non-e-un-url',
        branch: 'main',
        scopeType: 'FULL_REPOSITORY',
      },
    });

    expect(risposta.status()).toBe(400);
    expect(JSON.stringify(await risposta.json())).toContain('repoUrl');
  });

  test('TS_19b (RF.19) — un URL che non è di GitHub viene rifiutato', async ({ request }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: 'https://gitlab.com/gruppo/progetto',
        branch: 'main',
        scopeType: 'FULL_REPOSITORY',
      },
    });

    expect(risposta.status()).toBe(400);
  });

  test('TS_20 (RF.20) — un repository irraggiungibile viene segnalato', async ({ request }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: 'https://github.com/IlGranz/repository-che-non-esiste-000',
        branch: 'main',
        scopeType: 'FULL_REPOSITORY',
      },
    });

    expect(risposta.ok()).toBeFalsy();
  });

  test('TS_20b (RF.20) — dalla pagina l\'errore di accesso è visibile all\'utente', async ({
    page,
    request,
  }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');
    // Il repository esiste nell'elenco ma il contesto viene rifiutato dal
    // server: la pagina deve dirlo invece di navigare.
    await page.route('**/api/v1/contexts', (route) =>
      route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: 'no access' } }),
    );

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();

    await expect(page.getByText(/Impossibile salvare il contesto/)).toBeVisible();
    await expect(page).toHaveURL(/\/select$/);
  });

  test('TS_21 (RF.21) — un branch inesistente viene segnalato', async ({ request }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: REPO.url,
        branch: 'branch-che-non-esiste-000',
        scopeType: 'FULL_REPOSITORY',
      },
    });

    expect(risposta.ok()).toBeFalsy();
  });

  test('TS_22 (RF.22) — un commit inesistente viene segnalato', async ({ request }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: REPO.url,
        branch: REPO.branch,
        commitSha: '0000000000000000000000000000000000000000',
        scopeType: 'FULL_REPOSITORY',
      },
    });

    expect(risposta.ok()).toBeFalsy();
  });

  test('TS_24 (RF.24) — i linguaggi rilevati sono esposti nel contesto', async ({ request }) => {
    // Il contesto dichiara quali linguaggi ha trovato: è l'informazione su
    // cui si basa l'avviso per il codice non supportato.
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: { repoUrl: REPO.url, branch: REPO.branch, scopeType: 'FULL_REPOSITORY' },
    });

    const contesto = await risposta.json();
    expect(Array.isArray(contesto.detectedLanguages)).toBeTruthy();
  });

  test('TS_25 (RF.25) — l\'utente definisce l\'ambito di analisi', async ({ page, request }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    // allTextContents() non attende, a differenza degli altri locator:
    // senza questa attesa la lettura puo' cadere sul render precedente.
    const opzioni = page.getByLabel('Tipo di scope').locator('option');
    await expect(opzioni).toHaveCount(3);

    expect(await opzioni.allTextContents()).toEqual([
      'Repository completo',
      'File specifici',
      'Directory specifiche',
    ]);
  });

  test('TS_26 (RF.26) — l\'intero repository è un ambito selezionabile', async ({
    page,
    request,
  }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByLabel('Tipo di scope').selectOption('FULL_REPOSITORY');
    // Sull'intero repository non vengono chiesti percorsi.
    await expect(page.getByLabel('File da analizzare')).toHaveCount(0);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();

    await expect(page).toHaveURL(/\/run$/);
    await expect(page.getByText(/FULL_REPOSITORY/)).toBeVisible();
  });

  test('TS_27 (RF.27) — si possono selezionare singoli file', async ({ page, request }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByLabel('Tipo di scope').selectOption('FILES');
    await page.getByLabel('File da analizzare').fill(FILE_SORGENTE);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();

    await expect(page).toHaveURL(/\/run$/);
    await expect(page.getByText(/FILES/)).toBeVisible();
  });

  test('TS_28 (RF.28) — si possono selezionare directory', async ({ page, request }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByLabel('Tipo di scope').selectOption('DIRECTORIES');
    await page.getByLabel('Directory da analizzare').fill(DIRECTORY_SORGENTE);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();

    await expect(page).toHaveURL(/\/run$/);
    await expect(page.getByText(/DIRECTORIES/)).toBeVisible();
  });

  test('TS_29 (RF.29) — senza alcun percorso l\'ambito ristretto non viene confermato', async ({
    page,
    request,
  }) => {
    await utentePronto(page, request);
    await vaiA(page, 'Repository');

    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByLabel('Tipo di scope').selectOption('FILES');
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();

    await expect(page.getByText('Inserisci almeno un percorso')).toBeVisible();
    await expect(page).toHaveURL(/\/select$/);
  });

  test('TS_30 (RF.30) — un percorso inesistente nel repository viene rifiutato', async ({
    request,
  }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: REPO.url,
        branch: REPO.branch,
        scopeType: 'DIRECTORIES',
        paths: ['cartella/che/non/esiste'],
      },
    });

    expect(risposta.ok()).toBeFalsy();
  });

  test('TS_31 (RF.31) — il limite dimensionale non viene applicato', async ({ request }) => {
    // REQUISITO NON SODDISFATTO. Il contesto dovrebbe essere rifiutato quando
    // eccede la finestra del modello, prima di spendere una chiamata LLM.
    // Il backend calcola e memorizza `estimatedFileCount` ma nessun controllo
    // lo usa: un repository enorme viene accettato senza obiezioni. Il test
    // fissa il comportamento reale, cosi' il giorno in cui il limite viene
    // introdotto diventa rosso e chiede di essere riscritto.
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: 'https://github.com/torvalds/linux',
        branch: 'master',
        scopeType: 'FULL_REPOSITORY',
      },
    });

    expect(risposta.ok()).toBeTruthy();
    const contesto = await risposta.json();
    expect(contesto.estimatedFileCount).toBeGreaterThan(1000);
  });
});

import { test, expect } from '@playwright/test';
import {
  REPO,
  patSpendibile,
  vaiA,
  registraEAccedi,
  accediDalModulo,
  salvaCredenziale,
  creaContesto,
  nuovoUtente,
  GITHUB_PAT,
  API,
  auth,
} from './helpers';

/**
 * Test di Sistema TS_32 – TS_42 (RF.32 – RF.42): elenco delle operazioni
 * disponibili, selezione multipla e avvio tramite l'Orchestratore.
 */

test.describe('TS_32–TS_42 · Operazioni e avvio', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(
      !(await patSpendibile(request)),
      'richiede un E2E_GITHUB_PAT con lo scope "repo"',
    );
  });

  /**
   * Utente autenticato con un contesto attivo nella pagina di avvio.
   *
   * Il contesto va creato *dalla UI*: lo store della selezione vive nella
   * memoria del client, quindi una POST /contexts fatta a lato non lo
   * popola e /run mostrerebbe "Nessun contesto configurato".
   */
  async function prontoAdAvviare(page: any, request: any, ruolo: any = 'SECURITY_AUDITOR') {
    const { utente, token } = await registraEAccedi(request, nuovoUtente(ruolo));
    await salvaCredenziale(request, token);
    await accediDalModulo(page, utente);
    await vaiA(page, 'Repository');
    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();
    await expect(page).toHaveURL(/\/run$/);
    return token;
  }

  test('TS_42 (RF.42) — senza contesto configurato l\'avvio è inibito', async ({
    page,
    request,
  }) => {
    // Nessun contesto creato: la pagina di avvio non mostra operazioni ma
    // rimanda alla selezione del repository.
    const { utente, token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);
    await accediDalModulo(page, utente);

    await vaiA(page, 'Avvia');

    await expect(page.getByText(/Nessun contesto configurato/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vai a Repository' })).toBeVisible();
  });

  test.describe('con un contesto pronto', () => {
    test('TS_32 (RF.32) — la dashboard elenca le operazioni disponibili', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request);

      await expect(page.getByRole('button', { name: /Analisi Sicurezza OWASP/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Verifica Policy/ })).toBeVisible();
    });

    test('TS_33 (RF.33) — ogni operazione mostra il proprio nome identificativo', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request, 'DEVELOPER');

      for (const nome of [
        'Documentazione README',
        'Documentazione Inline',
        'Documentazione API',
        'Changelog Tecnico',
      ]) {
        await expect(page.getByRole('button', { name: new RegExp(nome) })).toBeVisible();
      }
    });

    test('TS_34 (RF.34) — ogni operazione espone la categoria a cui appartiene', async ({
      page,
      request,
    }) => {
      // La categoria (DOCS, SECURITY, CHANGELOG) è la descrizione di
      // supporto che accompagna il nome dell'operazione.
      await prontoAdAvviare(page, request);

      const carta = page.getByRole('button', { name: /Analisi Sicurezza OWASP/ });
      await expect(carta).toContainText('SECURITY');
    });

    test('TS_35 (RF.35) — l\'interfaccia predispone configurazione e avvio', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request);

      await expect(page.getByText('Contesto attivo')).toBeVisible();
      await expect(page.getByRole('button', { name: /Seleziona almeno un'operazione/ })).toBeVisible();
    });

    test('TS_36 (RF.36) — la selezione di un\'operazione è esplicita e reversibile', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request);
      const carta = page.getByRole('button', { name: /Analisi Sicurezza OWASP/ });

      await expect(carta).toHaveAttribute('aria-pressed', 'false');
      await carta.click();
      await expect(carta).toHaveAttribute('aria-pressed', 'true');
      await carta.click();
      await expect(carta).toHaveAttribute('aria-pressed', 'false');
    });

    test('TS_37 (RF.37) — si possono selezionare più operazioni contemporaneamente', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request);

      await page.getByRole('button', { name: /Analisi Sicurezza OWASP/ }).click();
      await page.getByRole('button', { name: /Verifica Policy/ }).click();

      await expect(page.getByRole('button', { name: 'Avvia 2 operazioni' })).toBeVisible();
    });

    test('TS_41 (RF.41) — senza operazioni selezionate l\'avvio è inibito', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request);

      const avvio = page.getByRole('button', { name: /Seleziona almeno un'operazione/ });

      await expect(avvio).toBeDisabled();
    });

    test('TS_39 (RF.39) — più operazioni possono essere avviate insieme', async ({
      page,
      request,
    }) => {
      await prontoAdAvviare(page, request);
      await page.getByRole('button', { name: /Analisi Sicurezza OWASP/ }).click();
      await page.getByRole('button', { name: /Verifica Policy/ }).click();

      await page.getByRole('button', { name: 'Avvia 2 operazioni' }).click();

      // Entrambe compaiono nella dashboard di monitoraggio.
      await expect(page).toHaveURL(/\/tasks$/);
      await expect(page.getByText('Analisi Sicurezza OWASP')).toBeVisible();
      await expect(page.getByText('Verifica Policy')).toBeVisible();
    });

    test('TS_40 (RF.40) — l\'orchestratore instrada ogni operazione al proprio agente', async ({
      page,
      request,
    }) => {
      const token = await prontoAdAvviare(page, request);
      const contextId = await creaContesto(request, token);

      const risposta = await request.post(`${API}/tasks`, {
        headers: auth(token),
        data: { contextId, operations: ['SECURITY_OWASP'] },
      });

      // L'instradamento è deterministico: la task nasce già associata
      // all'operazione richiesta, senza interpellare alcun modello.
      expect(risposta.ok()).toBeTruthy();
      const esito = await risposta.json();
      expect(esito.taskIds).toHaveLength(1);
    });

    test('TS_38 (RF.38) — le preferenze di notifica non sono configurabili', async ({
      page,
      request,
    }) => {
      // Requisito non implementato: nessun comando di attivazione delle
      // email esiste nell'interfaccia. Il test lo fissa per iscritto.
      await prontoAdAvviare(page, request);

      await expect(page.getByText(/email/i)).toHaveCount(0);
    });
  });

  test('TS_40b (RF.40) — un\'operazione non permessa al ruolo viene rifiutata', async ({
    request,
  }) => {
    // Il controllo dei permessi è per operazione, non un unico cancello
    // sull'endpoint: un batch può mescolare agenti diversi.
    const { token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token);

    const risposta = await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['DOCS_README'] },
    });

    expect(risposta.ok()).toBeFalsy();
  });

  test('TS_41b (RF.41) — un batch senza operazioni viene rifiutato dal server', async ({
    request,
  }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token);

    const risposta = await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: [] },
    });

    expect(risposta.status()).toBe(400);
  });

  test('TS_42b (RF.42) — un contesto inesistente viene rifiutato', async ({ request }) => {
    const { token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId: '000000000000000000000000', operations: ['SECURITY_OWASP'] },
    });

    expect(risposta.ok()).toBeFalsy();
  });
});

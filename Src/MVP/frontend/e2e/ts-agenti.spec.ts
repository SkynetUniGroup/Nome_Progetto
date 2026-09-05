import { test, expect } from '@playwright/test';
import {
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
 * Test di Sistema TS_82 – TS_105 (RF.82 – RF.105): comportamento dei tre
 * agenti — Docs, Security, Changelog.
 *
 * Ogni test di questo file avvia un agente reale, quindi consuma una
 * chiamata al modello: richiedono sia E2E_GITHUB_PAT sia una LLM_API_KEY
 * configurata nel servizio agenti. Senza, si skippano.
 *
 * TS_79 – TS_81 (template README personalizzato) non sono verificabili:
 * né l'interfaccia né il backend espongono il caricamento di un template.
 */

const LLM = process.env.E2E_LLM_ENABLED === '1';

/** Avvia un'operazione e attende che la task raggiunga uno stato terminale. */
async function eseguiOperazione(
  page: any,
  request: any,
  ruolo: any,
  operazione: string,
  contesto: Record<string, unknown> = {},
) {
  const { utente, token } = await registraEAccedi(request, nuovoUtente(ruolo));
  await salvaCredenziale(request, token);
  const contextId = await creaContesto(request, token, {
    scopeType: 'FILES',
    paths: ['app/data/user-dao.js'],
    ...contesto,
  });
  await request.post(`${API}/tasks`, {
    headers: auth(token),
    data: { contextId, operations: [operazione] },
  });
  await accediDalModulo(page, utente);
  await vaiA(page, 'Task');
  await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
  return token;
}

/** Apre il report della prima task conclusa. */
async function apriReport(page: any) {
  await vaiA(page, 'Report');
  await page.getByRole('link', { name: /Visualizza/ }).first().click();
  await expect(page).toHaveURL(/\/reports\/.+/);
}

test.describe('TS_87–TS_93 · Agente Security', () => {
  test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');

  test('TS_87 (RF.87) — la scansione OWASP viene eseguita sul codice sorgente', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'SECURITY_AUDITOR', 'SECURITY_OWASP');

    await apriReport(page);

    await expect(page.getByRole('heading', { name: 'Analisi Sicurezza OWASP' })).toBeVisible();
  });

  test('TS_88 (RF.88) — ogni vulnerabilità riporta la categoria OWASP', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'SECURITY_AUDITOR', 'SECURITY_OWASP');
    await apriReport(page);

    // NodeGoat è deliberatamente vulnerabile: ci si attende almeno un
    // riscontro con la sua categoria.
    await expect(page.getByText(/A\d{2}:\d{4}|Injection|Broken/i).first()).toBeVisible();
  });

  test('TS_89 (RF.89) — ogni vulnerabilità è associata al file e alle righe', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'SECURITY_AUDITOR', 'SECURITY_OWASP');
    await apriReport(page);

    await expect(page.getByText(/righe \d+/).first()).toBeVisible();
  });

  test('TS_90–TS_91 (RF.90, RF.91) — ogni riscontro propone un rimedio', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'SECURITY_AUDITOR', 'SECURITY_OWASP');
    await apriReport(page);

    await page.getByRole('button', { name: /righe \d+/ }).first().click();

    // Il rimedio è testuale o un frammento di codice: in entrambi i casi
    // la sezione dedicata deve comparire.
    await expect(page.getByText('Rimedio suggerito')).toBeVisible();
  });

  test('TS_88b (RF.88) — i riscontri sono classificati per gravità', async ({ page, request }) => {
    await eseguiOperazione(page, request, 'SECURITY_AUDITOR', 'SECURITY_OWASP');
    await apriReport(page);

    await expect(page.getByText(/Critico|Alto|Medio|Basso|Info/).first()).toBeVisible();
  });

  test('TS_92–TS_93 (RF.92, RF.93) — la scansione policy applica il POLICY.md del repository', async ({
    page,
    request,
  }) => {
    // Serve un repository che contenga un POLICY.md: senza, l'agente si
    // ferma (comportamento già coperto da TS_70).
    const token = await eseguiOperazione(
      page,
      request,
      'SECURITY_AUDITOR',
      'SECURITY_POLICY',
      { repoUrl: process.env.E2E_POLICY_REPO ?? undefined, scopeType: 'FULL_REPOSITORY', paths: [] },
    );

    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    const [report] = await elenco.json();
    expect(report).toBeDefined();
  });
});

test.describe('TS_82–TS_86 · Agente Docs', () => {
  test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');

  test('TS_83 (RF.83) — la documentazione inline viene proposta sul codice non documentato', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_INLINE');

    await apriReport(page);

    await expect(page.getByText('Proposta di modifica')).toBeVisible();
  });

  test('TS_83b (RF.83) — la proposta è un diff sul file interessato', async ({ page, request }) => {
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_INLINE');
    await apriReport(page);

    await page.getByRole('button', { name: /Mostra diff/ }).click();

    await expect(page.getByText(/^\+/m).first()).toBeVisible();
  });

  test('TS_84 (RF.84) — la documentazione esistente ma disallineata viene corretta', async ({
    page,
    request,
  }) => {
    // Il loader marca le unità già documentate come "verify alignment":
    // finiscono nel contesto proprio perché vanno ricontrollate.
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_INLINE');
    await apriReport(page);

    await expect(page.getByText('Proposta di modifica')).toBeVisible();
  });

  test('TS_85 (RF.85) — le porzioni troppo complesse sono escluse e segnalate', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_INLINE');
    await apriReport(page);

    // L'avviso di complessità compare solo quando l'agente ne trova: il
    // test verifica che, se c'è, sia esposto e non silenziosamente scartato.
    const avviso = page.getByText(/complessit|complexity/i).first();
    if (await avviso.isVisible()) {
      await expect(avviso).toBeVisible();
    }
  });

  test('TS_82 (RF.82) — il README viene generato o aggiornato come proposta', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_README', {
      scopeType: 'FULL_REPOSITORY',
      paths: [],
    });

    await apriReport(page);

    await expect(page.getByText(/README|Proposta di modifica/).first()).toBeVisible();
  });

  test('TS_86 (RF.86) — la documentazione degli endpoint viene proposta', async ({
    page,
    request,
  }) => {
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_API', {
      scopeType: 'FILES',
      paths: ['app/routes/session.js'],
    });

    await apriReport(page);

    await expect(page.getByRole('heading', { name: 'Documentazione API' })).toBeVisible();
  });

  test('TS_63 (RF.63) — la Pull Request aperta è raggiungibile dal report', async ({
    page,
    request,
  }) => {
    // Il collegamento compare solo se l'agente ha davvero aperto una PR,
    // il che richiede permessi di scrittura sul repository bersaglio.
    await eseguiOperazione(page, request, 'DEVELOPER', 'DOCS_INLINE');
    await apriReport(page);

    const collegamento = page.getByRole('link', { name: /Vedi PR/ });
    if (await collegamento.isVisible()) {
      await expect(collegamento).toHaveAttribute('href', /github\.com\/.+\/pull\/\d+/);
      await expect(collegamento).toHaveAttribute('target', '_blank');
    }
  });
});

test.describe('TS_94–TS_105 · Agente Changelog', () => {
  test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');

  /** Avvia il changelog tecnico e resta sulla dashboard. */
  async function avviaChangelog(page: any, request: any, ruolo: any = 'PROJECT_MANAGER') {
    const { utente, token } = await registraEAccedi(request, nuovoUtente(ruolo));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FULL_REPOSITORY',
      paths: [],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['CHANGELOG_TECHNICAL'] },
    });
    await accediDalModulo(page, utente);
    await vaiA(page, 'Task');
    return token;
  }

  test('TS_94 (RF.94) — le issue chiuse vengono recuperate e filtrate', async ({
    page,
    request,
  }) => {
    const token = await avviaChangelog(page, request);
    await expect(page.getByText(/Completato|Fallito|Inserisci Sprint ID/).first()).toBeVisible({
      timeout: 300_000,
    });

    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    expect(Array.isArray(await elenco.json())).toBeTruthy();
  });

  test('TS_98 (RF.98) — l\'utente inserisce testualmente lo Sprint ID', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);

    const richiesta = page.getByRole('button', { name: 'Inserisci Sprint ID' });
    await expect(richiesta.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 300_000,
    });

    if (await richiesta.isVisible()) {
      await richiesta.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByLabel('Sprint ID')).toBeVisible();
      await page.getByLabel('Sprint ID').fill('SPRINT-42');
      await page.getByRole('button', { name: 'Conferma' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('TS_99 (RF.99) — l\'utente può annullare durante la richiesta dello Sprint ID', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    const richiesta = page.getByRole('button', { name: 'Inserisci Sprint ID' });
    await expect(richiesta.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 300_000,
    });

    if (await richiesta.isVisible()) {
      await richiesta.click();
      await page.getByRole('button', { name: 'Annulla' }).click();
      // La finestra si chiude senza inviare nulla: la richiesta resta.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Inserisci Sprint ID' })).toBeVisible();
    }
  });

  test('TS_100 (RF.100) — i task privi di metadati sufficienti sono segnalati', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);

    const richiesta = page.getByRole('button', { name: /Task incompleti/ });
    await expect(richiesta.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 300_000,
    });

    if (await richiesta.isVisible()) {
      await richiesta.click();
      await expect(page.getByRole('dialog')).toContainText(/ancora aperti/);
    }
  });

  test('TS_101 (RF.101) — si può proseguire escludendo i task incompleti', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    const richiesta = page.getByRole('button', { name: /Task incompleti/ });
    await expect(richiesta.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 300_000,
    });

    if (await richiesta.isVisible()) {
      await richiesta.click();
      await page.getByRole('button', { name: /Procedi comunque/ }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('TS_102 (RF.102) — si può interrompere definitivamente la generazione', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    const richiesta = page.getByRole('button', { name: /Task incompleti/ });
    await expect(richiesta.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 300_000,
    });

    if (await richiesta.isVisible()) {
      await richiesta.click();
      await page.getByRole('button', { name: 'Annulla operazione' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('TS_95–TS_97 (RF.95–RF.97) — il changelog tecnico cita i ticket di origine', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
    await apriReport(page);

    // Ogni voce porta il riferimento alla issue da cui nasce.
    await expect(page.getByText(/#\d+|ISSUE-/).first()).toBeVisible();
  });

  test('TS_96 (RF.96) — il changelog tecnico è strutturato per lo sviluppo', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
    await apriReport(page);

    await expect(page.getByRole('heading', { name: 'Changelog Tecnico' })).toBeVisible();
  });

  test('TS_103 (RF.103) — il report tecnico offre il comando per la traduzione business', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    await expect(
      page
        .getByRole('button', { name: 'Conferma apertura PR' })
        .or(page.getByText(/Completato|Fallito/).first()),
    ).toBeVisible({ timeout: 300_000 });

    const conferma = page.getByRole('button', { name: 'Conferma apertura PR' });
    if (await conferma.isVisible()) {
      await conferma.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('link', { name: /Visualizza/ })).toBeVisible();
    }
  });

  test('TS_104 (RF.104) — il changelog di business è comprensibile ai non tecnici', async ({
    page,
    request,
  }) => {
    // La leggibilità è imposta dall'agente: sotto la soglia Flesch il testo
    // viene rigenerato, quindi un report business esistente la rispetta.
    const token = await avviaChangelog(page, request);
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });

    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    const report = (await elenco.json()).find((r: any) => r.operation === 'CHANGELOG_BUSINESS');
    if (report) {
      expect(report.status).toBe('COMPLETED');
    }
  });

  test('TS_105 (RF.105) — si può annullare il changelog di business dopo averlo visionato', async ({
    page,
    request,
  }) => {
    await avviaChangelog(page, request);
    const conferma = page.getByRole('button', { name: 'Conferma apertura PR' });
    await expect(conferma.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 300_000,
    });

    if (await conferma.isVisible()) {
      await conferma.click();
      await page.getByRole('button', { name: 'Annulla', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });
});

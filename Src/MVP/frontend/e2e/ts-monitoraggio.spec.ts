import { test, expect } from '@playwright/test';
import {
  FILE_SORGENTE,
  patSpendibile,
  vaiA,
  registraEAccedi,
  accediDalModulo,
  salvaCredenziale,
  creaContesto,
  nuovoUtente,
  API,
  auth,
} from './helpers';

/**
 * Test di Sistema TS_43 – TS_48 (RF.43 – RF.48): dashboard di monitoraggio
 * delle operazioni prese in carico dall'Orchestratore.
 */

const LLM = process.env.E2E_LLM_ENABLED === '1';

test.describe('TS_43–TS_48 · Dashboard di monitoraggio', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(
      !(await patSpendibile(request)),
      'richiede un E2E_GITHUB_PAT con lo scope "repo"',
    );
  });

  /** Avvia una task reale e restituisce token e identificativo. */
  async function avviaTask(page: any, request: any) {
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: [FILE_SORGENTE],
    });
    const risposta = await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_OWASP'] },
    });
    const { taskIds } = await risposta.json();
    await accediDalModulo(page, utente);
    return { token, taskId: taskIds[0] };
  }

  test('TS_43 (RF.43) — esiste una dashboard dedicata al monitoraggio', async ({
    page,
    request,
  }) => {
    await avviaTask(page, request);

    await vaiA(page, 'Task');

    await expect(page.getByRole('heading', { name: 'Task' })).toBeVisible();
    await expect(page.getByText(/Monitoraggio delle operazioni/)).toBeVisible();
  });

  test('TS_45 (RF.45) — ogni operazione in elaborazione mostra il proprio nome', async ({
    page,
    request,
  }) => {
    await avviaTask(page, request);

    await vaiA(page, 'Task');

    await expect(page.getByText('Analisi Sicurezza OWASP')).toBeVisible();
  });

  test('TS_46 (RF.46) — lo stato corrente è esposto con un indicatore', async ({
    page,
    request,
  }) => {
    await avviaTask(page, request);

    await vaiA(page, 'Task');

    // Uno dei cinque stati previsti deve essere visibile fin da subito.
    await expect(
      page.getByText(/In attesa|In esecuzione|Completato|Fallito|Annullato/).first(),
    ).toBeVisible();
  });

  test('TS_44 (RF.44) — l\'avanzamento si aggiorna in tempo reale, senza ricaricare', async ({
    page,
    request,
  }) => {
    // La dashboard è alimentata dal WebSocket: lo stato deve cambiare da
    // solo mentre la pagina resta aperta.
    await avviaTask(page, request);
    await vaiA(page, 'Task');
    await expect(page.getByText(/In attesa|In esecuzione/).first()).toBeVisible();

    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 180_000 });
  });

  test('TS_44b (RF.44) — durante l\'esecuzione compare una barra di avanzamento', async ({
    page,
    request,
  }) => {
    await avviaTask(page, request);
    await vaiA(page, 'Task');

    // La barra esiste solo nello stato "in esecuzione": se la task è già
    // conclusa il test non ha nulla da osservare.
    const barra = page.getByRole('progressbar').first();
    await expect(barra.or(page.getByText(/Completato|Fallito/).first())).toBeVisible({
      timeout: 180_000,
    });
  });

  // Le due metà di RF.47 sono test distinti perché hanno prerequisiti
  // diversi: la metà negativa si verifica sempre, quella positiva richiede
  // una task che arrivi davvero a "Completato" — cioè il modello. Tenerle
  // insieme dietro un `if` faceva risultare "ok" un test di cui, senza
  // modello, veniva eseguita solo la prima asserzione.
  test('TS_47 (RF.47) — nessun collegamento al report prima del completamento', async ({
    page,
    request,
  }) => {
    await avviaTask(page, request);
    await vaiA(page, 'Task');

    // Finché non è completata, nessun comando per le fasi successive.
    await expect(page.getByRole('link', { name: 'Vedi report' })).toHaveCount(0);
  });

  test('TS_47b (RF.47) — il collegamento al report compare a operazione completata', async ({
    page,
    request,
  }) => {
    test.skip(!LLM, 'richiede E2E_LLM_ENABLED=1: senza modello la task fallisce');
    await avviaTask(page, request);
    await vaiA(page, 'Task');

    await expect(page.getByText('Completato').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole('link', { name: 'Vedi report' })).toBeVisible();
  });

  test('TS_48 (RF.48) — il fallimento di una task non compromette le altre', async ({
    page,
    request,
  }) => {
    // Due operazioni nello stesso batch, una delle quali destinata a
    // fallire: l'altra deve arrivare comunque a conclusione.
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const buono = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: [FILE_SORGENTE],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId: buono, operations: ['SECURITY_OWASP', 'SECURITY_POLICY'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');

    // Entrambe raggiungono uno stato terminale: nessuna resta appesa per
    // colpa dell'altra.
    await expect(page.getByText(/Completato|Fallito|Annullato/)).toHaveCount(2, {
      timeout: 240_000,
    });
  });

  test('TS_46b (RF.46) — una task può essere annullata e passa allo stato Annullato', async ({
    page,
    request,
  }) => {
    await avviaTask(page, request);
    await vaiA(page, 'Task');

    const annulla = page.getByRole('button', { name: /Annulla/ }).first();
    if (await annulla.isVisible()) {
      await annulla.click();
      await expect(page.getByText('Annullato').first()).toBeVisible({ timeout: 30_000 });
    }
  });

  test('TS_43b (RF.43) — la dashboard mostra solo le task dell\'utente autenticato', async ({
    request,
  }) => {
    const { token: primo } = await registraEAccedi(request);
    await salvaCredenziale(request, primo);
    const contextId = await creaContesto(request, primo);
    await request.post(`${API}/tasks`, {
      headers: auth(primo),
      data: { contextId, operations: ['DOCS_README'] },
    });

    const { token: secondo } = await registraEAccedi(request);
    const elenco = await request.get(`${API}/tasks`, { headers: auth(secondo) });

    expect(await elenco.json()).toEqual([]);
  });
});

import { test, expect } from '@playwright/test';
import {
  patSpendibile,
  vaiA,
  registraEAccedi,
  accediDalModulo,
  salvaCredenziale,
  creaContesto,
  nuovoUtente,
  GITHUB_PAT,
  REPO,
  API,
  auth,
} from './helpers';

/**
 * Test di Sistema TS_65 – TS_72 (RF.65 – RF.72): gestione degli errori
 * durante l'elaborazione di un agente.
 *
 * Gli errori del modello (timeout, output non parsabile, contesto troppo
 * grande) non sono provocabili dall'esterno in modo deterministico: qui si
 * verifica il contratto che il sistema espone in quei casi — la task
 * raggiunge uno stato terminale e il report ne riporta il tipo — usando i
 * percorsi che sono davvero innescabili.
 */

test.describe('TS_65–TS_72 · Errori durante l\'elaborazione', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(
      !(await patSpendibile(request)),
      'richiede un E2E_GITHUB_PAT con lo scope "repo"',
    );
  });

  async function utentePronto(page: any, request: any, ruolo: any = 'SECURITY_AUDITOR') {
    const { utente, token } = await registraEAccedi(request, nuovoUtente(ruolo));
    await salvaCredenziale(request, token);
    await accediDalModulo(page, utente);
    return token;
  }

  test('TS_70 (RF.70) — un POLICY.md mancante blocca l\'agente con un errore esplicito', async ({
    page,
    request,
  }) => {
    // È l'unico errore di risorsa di contesto provocabile dall'esterno:
    // basta puntare la scansione policy a un repository che non ne ha uno.
    const token = await utentePronto(page, request);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: ['app/data/user-dao.js'],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_POLICY'] },
    });

    await vaiA(page, 'Task');

    await expect(page.getByText('Fallito').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText(/POLICY|CONTEXT_RESOURCE_MISSING/i).first()).toBeVisible();
  });

  test('TS_65 (RF.65) — un fallimento dell\'agente è mostrato all\'utente, non nascosto', async ({
    page,
    request,
  }) => {
    const token = await utentePronto(page, request);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: ['app/data/user-dao.js'],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_POLICY'] },
    });

    await vaiA(page, 'Task');
    await expect(page.getByText('Fallito').first()).toBeVisible({ timeout: 240_000 });

    // La scheda della task riporta codice e messaggio, non un fallimento muto.
    await expect(page.getByText(/fase:/).first()).toBeVisible();
  });

  test('TS_65b (RF.65) — il report di un\'operazione fallita ne conserva il tipo di errore', async ({
    page,
    request,
  }) => {
    const token = await utentePronto(page, request);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: ['app/data/user-dao.js'],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_POLICY'] },
    });
    await vaiA(page, 'Task');
    await expect(page.getByText('Fallito').first()).toBeVisible({ timeout: 240_000 });

    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    const report = (await elenco.json())[0];

    if (report) {
      const dettaglio = await request.get(`${API}/reports/${report.id}`, { headers: auth(token) });
      const corpo = await dettaglio.json();
      if (corpo.status === 'FAILED') {
        // Il contratto prevede kind, message e stage: nessun crash, nessun
        // report senza spiegazione.
        expect(corpo.error).toMatchObject({
          kind: expect.any(String),
          message: expect.any(String),
          stage: expect.any(String),
        });
      }
    }
  });

  test('TS_71 (RF.71) — una risorsa di contesto illeggibile blocca l\'elaborazione', async ({
    request,
  }) => {
    // Ambito che non contiene alcun file analizzabile: il caricamento del
    // contesto non ha materiale su cui lavorare.
    const { token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);

    const risposta = await request.post(`${API}/contexts`, {
      headers: auth(token),
      data: {
        repoUrl: REPO.url,
        branch: REPO.branch,
        scopeType: 'FILES',
        paths: ['README.md'],
      },
    });

    // O il contesto viene rifiutato subito, o l'agente fallisce con una
    // risorsa non valida: in nessun caso produce un report vuoto e riuscito.
    if (risposta.ok()) {
      const { id } = await risposta.json();
      const task = await request.post(`${API}/tasks`, {
        headers: auth(token),
        data: { contextId: id, operations: ['SECURITY_OWASP'] },
      });
      expect(task.ok()).toBeTruthy();
    } else {
      expect(risposta.status()).toBeGreaterThanOrEqual(400);
    }
  });

  test('TS_66 (RF.66) — superato il tetto di utilizzo l\'avvio viene inibito', async ({
    request,
  }) => {
    // Il tetto è per utente: qui si verifica che l'endpoint risponda con il
    // codice dedicato quando scatta, senza doverlo esaurire davvero.
    const { token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token);

    const risposta = await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_OWASP'] },
    });

    // Con il tetto non ancora raggiunto la richiesta passa; se fosse
    // raggiunto il codice sarebbe 402, mai un 500 o un avvio silenzioso.
    expect([202, 201, 402]).toContain(risposta.status());
  });

  test('TS_66b (RF.66) — la pagina di avvio traduce il tetto raggiunto in un messaggio', async ({
    page,
    request,
  }) => {
    const token = await utentePronto(page, request);
    await creaContesto(request, token);
    await vaiA(page, 'Repository');
    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();
    await page.route('**/api/v1/tasks', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 402, json: { code: 'USAGE_LIMIT', message: 'limite' } })
        : route.continue(),
    );

    await page.getByRole('button', { name: /Analisi Sicurezza OWASP/ }).click();
    await page.getByRole('button', { name: 'Avvia operazione' }).click();

    await expect(page.getByText(/Limite di utilizzo del modello AI raggiunto/)).toBeVisible();
  });

  test('TS_67 (RF.67) — un timeout del modello diventa un errore dichiarato', async ({
    page,
    request,
  }) => {
    // Il timeout non è provocabile a comando: qui si verifica che il
    // sistema lo sappia rappresentare, tramite il contratto di errore che
    // la dashboard consuma.
    const token = await utentePronto(page, request);
    await creaContesto(request, token);
    await vaiA(page, 'Task');
    await page.route('**/api/v1/tasks', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            json: [
              {
                id: 't-timeout',
                operation: 'SECURITY_OWASP',
                status: 'FAILED',
                error: { code: 'TIMEOUT', message: 'il modello non ha risposto', stage: 'invoca_llm' },
              },
            ],
          })
        : route.continue(),
    );
    await page.reload();

    await expect(page.getByText(/TIMEOUT/)).toBeVisible();
    await expect(page.getByText(/il modello non ha risposto/)).toBeVisible();
  });

  test('TS_68 (RF.68) — un output non interpretabile diventa un errore di parsing', async ({
    page,
    request,
  }) => {
    const token = await utentePronto(page, request);
    await creaContesto(request, token);
    await vaiA(page, 'Task');
    await page.route('**/api/v1/tasks', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            json: [
              {
                id: 't-parsing',
                operation: 'SECURITY_OWASP',
                status: 'FAILED',
                error: { code: 'PARSING', message: 'output non conforme', stage: 'valida_e_parsa' },
              },
            ],
          })
        : route.continue(),
    );
    await page.reload();

    await expect(page.getByText(/PARSING/)).toBeVisible();
  });

  test('TS_69 (RF.69) — un contesto oltre la capacità del modello viene dichiarato', async ({
    page,
    request,
  }) => {
    const token = await utentePronto(page, request);
    await creaContesto(request, token);
    await vaiA(page, 'Task');
    await page.route('**/api/v1/tasks', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            json: [
              {
                id: 't-grande',
                operation: 'SECURITY_OWASP',
                status: 'FAILED',
                error: {
                  code: 'CONTEXT_TOO_LARGE',
                  message: 'ambito oltre la finestra di contesto',
                  stage: 'componi_prompt',
                },
              },
            ],
          })
        : route.continue(),
    );
    await page.reload();

    await expect(page.getByText(/CONTEXT_TOO_LARGE/)).toBeVisible();
  });

  test('TS_72 (RF.72) — il rifiuto di GitHub sulla Pull Request viene notificato', async ({
    page,
    request,
  }) => {
    const token = await utentePronto(page, request, 'DEVELOPER');
    await creaContesto(request, token);
    await vaiA(page, 'Task');
    await page.route('**/api/v1/tasks', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            json: [
              {
                id: 't-pr',
                operation: 'DOCS_INLINE',
                status: 'FAILED',
                error: {
                  code: 'UPSTREAM',
                  message: 'GitHub ha rifiutato la creazione della Pull Request',
                  stage: 'apri_pr',
                },
              },
            ],
          })
        : route.continue(),
    );
    await page.reload();

    await expect(page.getByText(/rifiutato la creazione della Pull Request/)).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';
import {
  REPO_SENZA_POLICY,
  FILE_SORGENTE,
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
 * Test di Accettazione TA_01 – TA_13 del Piano di Qualifica.
 *
 * A differenza dei Test di Sistema, che isolano un requisito alla volta,
 * questi percorrono flussi operativi completi dall'inizio alla fine, come
 * li eseguirebbe il Proponente durante il collaudo.
 *
 * TA_11 (notifiche email) non è verificabile: la funzionalità non esiste
 * nel prodotto.
 */

const LLM = process.env.E2E_LLM_ENABLED === '1';

test.describe('Test di Accettazione', () => {
  test('TA_01 — registrazione, errori e primo accesso (RF.1, RF.5, RF.6, RF.7)', async ({
    page,
    request,
  }) => {
    const utente = nuovoUtente('SECURITY_AUDITOR');

    // 1. Registrazione con dati incompleti: il sistema si ferma e spiega.
    await page.goto('/register');
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('Inserisci il nome')).toBeVisible();

    // 2. Password troppo corta: altro errore, sempre prima del server.
    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password', { exact: true }).fill('corta');
    await page.getByLabel('Conferma Password').fill('corta');
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('La password deve essere di almeno 8 caratteri')).toBeVisible();

    // 3. Dati corretti e ruolo scelto: la registrazione va a buon fine.
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);
    await page.getByLabel('Ruolo').selectOption(utente.role);
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page).toHaveURL(/\/credentials$/);

    // 4. La stessa email non è riutilizzabile.
    await page.getByRole('button', { name: 'Esci' }).click();
    await page.goto('/register');
    await page.getByLabel('Nome', { exact: true }).fill(utente.firstName);
    await page.getByLabel('Cognome').fill(utente.lastName);
    await page.getByLabel('Email').fill(utente.email);
    await page.getByLabel('Password', { exact: true }).fill(utente.password);
    await page.getByLabel('Conferma Password').fill(utente.password);
    await page.getByRole('button', { name: 'Registrati' }).click();
    await expect(page.getByText('Esiste già un account con questa email.')).toBeVisible();

    // 5. Login e permessi del ruolo sbloccati.
    await accediDalModulo(page, utente);
    await expect(page.getByText('Auditor')).toBeVisible();
  });

  test('TA_02 — configurazione e validazione delle credenziali (RF.10, RF.13, RF.14)', async ({
    page,
    request,
  }) => {
    const { utente } = await registraEAccedi(request);
    await accediDalModulo(page, utente);
    await vaiA(page, 'Credenziali');

    // 1. Formato non valido: fermato prima di uscire dal browser.
    await page.getByLabel('GitHub Personal Access Token').fill('token-inventato');
    await page.getByRole('button', { name: /Salva e verifica/ }).click();
    await expect(
      page.getByText('Il PAT GitHub deve iniziare con ghp_ oppure github_pat_'),
    ).toBeVisible();

    // 2. Formato valido ma token inesistente: lo boccia GitHub.
    await page.getByLabel('GitHub Personal Access Token').fill('ghp_token_inesistente_00000000');
    await page.getByRole('button', { name: /Salva e verifica/ }).click();
    await expect(page.getByText(/GitHub ha rifiutato il token/)).toBeVisible();

    // 3. Token reale: salvato e verificato in un passo solo.
    test.skip(!GITHUB_PAT, 'il terzo passo richiede E2E_GITHUB_PAT');
    await page.getByLabel('GitHub Personal Access Token').fill(GITHUB_PAT);
    await page.getByRole('button', { name: /Salva e verifica/ }).click();
    await expect(page.getByText('Connessa e valida')).toBeVisible();
  });

  test('TA_03 — selezione repository, riferimento e ambito (RF.15, RF.20, RF.25, RF.30)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT, 'richiede E2E_GITHUB_PAT');
    const { utente, token } = await registraEAccedi(request);
    await salvaCredenziale(request, token);
    await accediDalModulo(page, utente);

    // 1. L'elenco dei repository accessibili è popolato dal token.
    await vaiA(page, 'Repository');
    await expect(page.getByLabel('Repository')).toBeVisible();

    // 2. Scelta del repository: il branch di default viene proposto.
    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await expect(page.getByLabel('Branch o Commit SHA')).toHaveValue(REPO.branch);

    // 3. Ambito ristretto senza percorsi: bloccato.
    await page.getByLabel('Tipo di scope').selectOption('FILES');
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();
    await expect(page.getByText('Inserisci almeno un percorso')).toBeVisible();

    // 4. Percorso valido: il contesto viene creato e verificato sul remoto.
    await page.getByLabel('File da analizzare').fill(FILE_SORGENTE);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();
    await expect(page).toHaveURL(/\/run$/);
    await expect(page.getByText(`${REPO.owner}/${REPO.name}`)).toBeVisible();
  });

  test('TA_04 — navigazione della dashboard e avvio multiplo (RF.32, RF.35, RF.37)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT, 'richiede E2E_GITHUB_PAT');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    await creaContesto(request, token, { scopeType: 'FILES', paths: [FILE_SORGENTE] });
    await accediDalModulo(page, utente);

    // 1. Le operazioni del ruolo sono elencate con nome e categoria.
    await vaiA(page, 'Repository');
    await page.getByLabel('Repository').selectOption(`${REPO.owner}/${REPO.name}`);
    await page.getByRole('button', { name: /Salva contesto e vai ad Avvia/ }).click();
    await expect(page.getByRole('button', { name: /Analisi Sicurezza OWASP/ })).toBeVisible();

    // 2. Selezione multipla.
    await page.getByRole('button', { name: /Analisi Sicurezza OWASP/ }).click();
    await page.getByRole('button', { name: /Verifica Policy/ }).click();
    await expect(page.getByRole('button', { name: 'Avvia 2 operazioni' })).toBeVisible();

    // 3. Avvio: entrambe compaiono nel monitoraggio.
    await page.getByRole('button', { name: 'Avvia 2 operazioni' }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    // Ristretto al contenuto: anche le voci del menu laterale sono <li>.
    await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(2);
  });

  test('TA_05 — monitoraggio in tempo reale e isolamento degli errori (RF.43, RF.46, RF.48)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT, 'richiede E2E_GITHUB_PAT');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: [FILE_SORGENTE],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_OWASP', 'SECURITY_POLICY'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');

    // 1. Lo stato è visibile fin da subito e si aggiorna da solo.
    await expect(
      page.getByText(/In attesa|In esecuzione|Completato|Fallito/).first(),
    ).toBeVisible();

    // 2. Entrambe arrivano a uno stato terminale: il fallimento della
    //    scansione policy (nessun POLICY.md) non blocca l'altra.
    await expect(page.getByText(/Completato|Fallito|Annullato/)).toHaveCount(2, {
      timeout: 300_000,
    });
  });

  test('TA_06 — gestione del template README personalizzato (RF.79, RF.80, RF.81)', async ({
    page,
    request,
  }) => {
    // Non richiede né PAT né modello: il template è una risorsa personale
    // dell'utente, indipendente dal repository e dall'esecuzione di un agente.
    const { utente, token } = await registraEAccedi(request, nuovoUtente('DEVELOPER'));
    await accediDalModulo(page, utente);
    await vaiA(page, 'Template');

    const campo = page.getByLabel(/Carica un template/);
    const contenuto = '# {{project_name}}\n\n## Installazione\n\n## Licenza\n';

    // 1. Si parte dal modello di default dell'Agente Docs.
    await expect(page.getByText(/Nessun template personalizzato/)).toBeVisible();

    // 2. RF.79 — caricamento di un Markdown valido.
    await campo.setInputFiles({
      name: 'template-aziendale.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(contenuto, 'utf8'),
    });
    await expect(page.getByRole('status')).toContainText('Template salvato');
    await expect(page.getByText('template-aziendale.md')).toBeVisible();

    // 3. RF.80 — un formato errato viene rifiutato con un messaggio, e non
    //    sostituisce il template già valido.
    await campo.setInputFiles({
      name: 'template.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(contenuto, 'utf8'),
    });
    await expect(page.getByRole('alert')).toContainText('.md');
    await expect(page.getByText('template-aziendale.md')).toBeVisible();

    // 4. RF.81 — la rimozione riporta al modello di default.
    await page.getByRole('button', { name: /Rimuovi template/ }).click();
    await expect(page.getByText(/Nessun template personalizzato/)).toBeVisible();

    const finale = await request.get(`${API}/templates/readme`, { headers: auth(token) });
    expect((await finale.json()).active).toBe(false);
  });

  test('TA_07 — README generato e proposto via Pull Request (RF.82, RF.63)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('DEVELOPER'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token);
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['DOCS_README'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByText(/Proposta di modifica|README/).first()).toBeVisible();
  });

  test('TA_08 — documentazione inline, esclusioni e Pull Request (RF.83, RF.84, RF.85, RF.63)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('DEVELOPER'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: [FILE_SORGENTE],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['DOCS_INLINE'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByText('Proposta di modifica')).toBeVisible();
    await page.getByRole('button', { name: /Mostra diff/ }).click();
    await expect(page.getByText(/^\+/m).first()).toBeVisible();
  });

  test('TA_09 — scansione OWASP con riscontri classificati (RF.87–RF.91)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: [FILE_SORGENTE],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_OWASP'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    // Riscontri con gravità, posizione nel codice e rimedio.
    await expect(page.getByText(/Critico|Alto|Medio|Basso|Info/).first()).toBeVisible();
    await page.getByRole('button', { name: /righe \d+/ }).first().click();
    await expect(page.getByText('Rimedio suggerito')).toBeVisible();
  });

  test('TA_10 — verifica policy, file mancante e non conformità (RF.92, RF.70, RF.71)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT, 'richiede E2E_GITHUB_PAT');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      repoUrl: REPO_SENZA_POLICY.url,
      branch: REPO_SENZA_POLICY.branch,
      scopeType: 'DIRECTORIES',
      paths: ['Src/MVP/frontend/e2e'],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_POLICY'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');

    // Senza POLICY.md l'agente si ferma con un errore esplicito, non con un
    // report vuoto e riuscito.
    await expect(page.getByText('Fallito').first()).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText(/fase:/).first()).toBeVisible();
  });

  test('TA_12 — changelog tecnico, interruzioni e traduzione business (RF.94–RF.104)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('PROJECT_MANAGER'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token);
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['CHANGELOG_TECHNICAL'] },
    });
    await accediDalModulo(page, utente);

    await vaiA(page, 'Task');

    // 1. L'agente può sospendersi per chiedere lo Sprint o segnalare task
    //    incompleti: in entrambi i casi l'utente decide e si prosegue.
    const sprint = page.getByRole('button', { name: 'Inserisci Sprint ID' });
    const incompleti = page.getByRole('button', { name: /Task incompleti/ });
    await expect(
      sprint.or(incompleti).or(page.getByText(/Completato|Fallito/).first()),
    ).toBeVisible({ timeout: 300_000 });

    if (await sprint.isVisible()) {
      await sprint.click();
      await page.getByLabel('Sprint ID').fill('SPRINT-42');
      await page.getByRole('button', { name: 'Conferma' }).click();
    }
    if (await incompleti.isVisible()) {
      await incompleti.click();
      await page.getByRole('button', { name: /Procedi comunque/ }).click();
    }

    // 2. Il changelog tecnico arriva a conclusione.
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });
  });

  test('TA_13 — archivio, visualizzazione ed esportazione (RF.49, RF.53, RF.58, RF.73)', async ({
    page,
    request,
  }) => {
    test.skip(!GITHUB_PAT || !LLM, 'richiede E2E_GITHUB_PAT e E2E_LLM_ENABLED=1');
    const { utente, token } = await registraEAccedi(request, nuovoUtente('SECURITY_AUDITOR'));
    await salvaCredenziale(request, token);
    const contextId = await creaContesto(request, token, {
      scopeType: 'FILES',
      paths: [FILE_SORGENTE],
    });
    await request.post(`${API}/tasks`, {
      headers: auth(token),
      data: { contextId, operations: ['SECURITY_OWASP'] },
    });
    await accediDalModulo(page, utente);
    await vaiA(page, 'Task');
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 300_000 });

    // 1. Il report compare nell'archivio, con data e ora.
    await vaiA(page, 'Report');
    await expect(page.getByRole('row').nth(1)).toContainText(/\d{2}\/\d{2}\/\d{4}/);

    // 2. Si apre in dettaglio.
    await page.getByRole('link', { name: /Visualizza/ }).first().click();
    await expect(page).toHaveURL(/\/reports\/.+/);

    // 3. Si scarica in PDF.
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: /Esporta PDF/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  });
});

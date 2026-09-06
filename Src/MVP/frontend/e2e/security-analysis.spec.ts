import { test, expect } from '@playwright/test';

/**
 * TA_09 (PdQ) — "Verificare che l'Agente Security esegua con successo la
 * scansione del codice sorgente alla ricerca di vulnerabilita' (OWASP Top
 * 10) e generi un report contenente le criticita' classificate per
 * gravita'." Copre anche i relativi Test di Sistema (RF.15, RF.25, RF.87,
 * RF.88, RF.89, RF.90/91, RF.53, RF.54, RF.60/61).
 *
 * E' un test end-to-end REALE: nessuna parte e' mockata. Il backend
 * chiama davvero le API di GitHub (repository pubblico, sola lettura) e
 * l'agente Python chiama davvero l'LLM configurato in LLM_API_KEY.
 * Repository scelto: OWASP/NodeGoat — applicazione Node.js scritta
 * apposta dall'OWASP con vulnerabilita' didattiche reali, cosi' il test
 * verifica non solo che il flusso "funzioni", ma che l'agente trovi
 * davvero qualcosa (branch 'master', ambito ristretto a app/routes/ per
 * restare ben sotto il limite di 100 file di RF.31 e velocizzare la
 * chiamata LLM).
 *
 * Richiede E2E_GITHUB_PAT nel .env alla radice del repo (un PAT read-only
 * su repository pubblici basta) — vedi TESTING.md. Se manca, il test si
 * skippa da solo invece di fallire, per non rompere una run che non ha
 * quella variabile configurata (es. CI).
 */
const GITHUB_PAT = process.env.E2E_GITHUB_PAT;

test.describe('Flusso completo: Agente Security — scansione OWASP su repository reale', () => {
  test.skip(!GITHUB_PAT, 'E2E_GITHUB_PAT non impostato nel .env — vedi TESTING.md');

  // Chiamata LLM reale: puo' impiegare fino a qualche minuto (RQ.6 accetta
  // fino a 5 min per singolo agente). Diamo margine oltre il default.
  test.setTimeout(6 * 60_000);

  test('registra il token, avvia la scansione su OWASP/NodeGoat e visualizza il report con i findings', async ({ page }) => {
    // --- Setup: registrazione del PAT reale ---
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByPlaceholder('ghp_xxxxxxxxxxxx...').fill(GITHUB_PAT!);
    await page.getByRole('button', { name: 'Salva e Inizia' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');

    // --- Selezione repository e ambito (RF.15, RF.16, RF.17, RF.25) ---
    await page.getByPlaceholder('skynetunigroup').fill('OWASP');
    await page.getByPlaceholder('code_guardian').fill('NodeGoat');
    const refInput = page.getByPlaceholder('main');
    await refInput.fill('master');
    await page.getByPlaceholder('es. Src/').fill(DIRECTORY_SORGENTE);

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    const operationSelect = page.getByRole('combobox');
    await expect(operationSelect).toBeVisible();
    await operationSelect.selectOption({ value: 'SECURITY_OWASP' });

    // --- Avvio (RF.35, RF.40): crea il contesto (chiamata reale a GitHub) e la task ---
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();
    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });

    // --- Monitoraggio (RF.44, RF.46): attende COMPLETED via WebSocket, non poll ---
    await expect(page.getByText('Analisi completata!')).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByText('Analisi fallita')).not.toBeVisible();

    // --- Visualizzazione report (RF.53, RF.54, RF.60, RF.61) ---
    await page.getByRole('link', { name: 'Visualizza Report →' }).click();
    await expect(page).toHaveURL(/\/reports\/.+/);
    await expect(page.getByRole('heading', { name: 'Analisi: SECURITY_OWASP' })).toBeVisible();
    await expect(page.getByText('COMPLETED')).toBeVisible();

    // NodeGoat contiene vulnerabilita' didattiche reali in app/routes/: ci
    // aspettiamo che l'agente ne trovi almeno una, non solo che l'analisi
    // "non sia fallita".
    await expect(page.getByText('Dettagli')).toBeVisible();
  });
});

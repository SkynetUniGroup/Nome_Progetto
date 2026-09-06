import { test, expect } from '@playwright/test';

/**
 * Ulteriori Test di Sistema sulla selezione del riferimento/ambito, reali
 * (nessun mock). Nota di implementazione: l'AdR descrive branch e commit
 * come due campi separati (UC9.3/UC9.4) e un selettore di tipologia
 * branch/PR (UC9.2); l'interfaccia realizzata in questo PoC li unisce in
 * un unico campo generico "Ref" e non ha alcun selettore per le Pull
 * Request — quindi RF.21 (branch inesistente) e RF.22 (commit inesistente)
 * collassano nello stesso comportamento osservabile da UI (un ref non
 * risolvibile), e RF.23/RF.18 (riferimento a una Pull Request) non sono
 * testabili perché l'opzione non esiste in interfaccia.
 */
const GITHUB_PAT = process.env.E2E_GITHUB_PAT;

test.describe('Riferimento e ambito', () => {
  test.skip(!GITHUB_PAT, 'E2E_GITHUB_PAT non impostato nel .env — vedi TESTING.md');

  async function login(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.getByPlaceholder('ghp_xxxxxxxxxxxx...').fill(GITHUB_PAT!);
    await page.getByRole('button', { name: 'Salva e Inizia' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');
  }

  test('RF.21/RF.22 — ref (branch o commit) inesistente: errore esplicito, nessun avvio', async ({ page }) => {
    await login(page);
    await page.getByPlaceholder('skynetunigroup').fill('OWASP');
    await page.getByPlaceholder('code_guardian').fill('NodeGoat');
    await page.getByPlaceholder('main').fill('questo-ref-non-esiste-e2e-12345');
    await page.getByPlaceholder('es. Src/').fill(DIRECTORY_SORGENTE);

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'SECURITY_OWASP' });

    const dialogPromise = page.waitForEvent('dialog');
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('Errore');
    await dialog.accept();
    await expect(page).toHaveURL('http://localhost:5173/');
  });

  test('RF.26/UC16.1 — nessuno scope selezionato (intero repository): completa con successo se sotto il limite file', async ({ page }) => {
    await login(page);
    // Repository di fixture creato per i test precedenti (3-4 file
    // totali): FULL_REPOSITORY qui resta ampiamente sotto il limite di
    // 100 file di RF.31, a differenza di NodeGoat/Code_Guardian usati
    // negli altri test proprio per superarlo.
    await page.getByPlaceholder('skynetunigroup').fill('IlGranz');
    await page.getByPlaceholder('code_guardian').fill('codeguardian-e2e-fixture');
    await page.getByPlaceholder('main').fill('develop');
    // Scope lasciato vuoto di proposito.

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'SECURITY_OWASP' });
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();

    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
    await expect(page.getByText('Analisi completata!')).toBeVisible({ timeout: 5 * 60_000 });
  });

  test('RF.27 — ambito ristretto a un singolo file (non una directory): funziona', async ({ page }) => {
    await login(page);
    await page.getByPlaceholder('skynetunigroup').fill('IlGranz');
    await page.getByPlaceholder('code_guardian').fill('codeguardian-e2e-fixture');
    await page.getByPlaceholder('main').fill('develop');
    await page.getByPlaceholder('es. Src/').fill('src/example.js'); // percorso di file, non di directory

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'SECURITY_OWASP' });
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();

    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
    await expect(page.getByText('Analisi completata!')).toBeVisible({ timeout: 5 * 60_000 });
  });

  test('RF.30/UC18 — ambito (directory) inesistente in un repository valido: errore esplicito', async ({ page }) => {
    await login(page);
    await page.getByPlaceholder('skynetunigroup').fill('IlGranz');
    await page.getByPlaceholder('code_guardian').fill('codeguardian-e2e-fixture');
    await page.getByPlaceholder('main').fill('develop');
    await page.getByPlaceholder('es. Src/').fill('questa-cartella-non-esiste-nel-repo');

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'SECURITY_OWASP' });

    const dialogPromise = page.waitForEvent('dialog');
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('Errore');
    await dialog.accept();
  });
});

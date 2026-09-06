import { test, expect } from '@playwright/test';

/**
 * TS/TA per l'Agente Docs, operazione DOCS_INLINE (RF.83, RF.84, RF.85).
 * End-to-end reale: GitHub e LLM veri, stesso repository/ambito del test
 * Security (OWASP/NodeGoat, app/routes/) per riuso e velocita' — vedi
 * security-analysis.spec.ts per i dettagli della scelta.
 *
 * A differenza di Security (che produce una lista di finding), Docs
 * produce una singola Proposta di modifica (diff unificato, RF.63):
 * verifichiamo che il diff venga generato e mostrato, non una lista.
 */
const GITHUB_PAT = process.env.E2E_GITHUB_PAT;

test.describe('Flusso completo: Agente Docs — documentazione inline su repository reale', () => {
  test.skip(!GITHUB_PAT, 'E2E_GITHUB_PAT non impostato nel .env — vedi TESTING.md');
  test.setTimeout(6 * 60_000);

  test('avvia DOCS_INLINE su OWASP/NodeGoat e visualizza la proposta di diff', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('ghp_xxxxxxxxxxxx...').fill(GITHUB_PAT!);
    await page.getByRole('button', { name: 'Salva e Inizia' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');

    await page.getByPlaceholder('skynetunigroup').fill('OWASP');
    await page.getByPlaceholder('code_guardian').fill('NodeGoat');
    await page.getByPlaceholder('main').fill('master');
    await page.getByPlaceholder('es. Src/').fill(DIRECTORY_SORGENTE);

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'DOCS_INLINE' });
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();

    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
    await expect(page.getByText('Analisi completata!')).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByText('Analisi fallita')).not.toBeVisible();

    await page.getByRole('link', { name: 'Visualizza Report →' }).click();
    await expect(page.getByRole('heading', { name: 'Analisi: DOCS_INLINE' })).toBeVisible();

    // RF.63: la proposta di modifica generata dall'agente deve comparire
    // come diff unificato leggibile, con il percorso del file target.
    await expect(page.getByText('Proposta di modifica (Diff)')).toBeVisible();
    await expect(page.getByText(/^File: /)).toBeVisible();
  });
});

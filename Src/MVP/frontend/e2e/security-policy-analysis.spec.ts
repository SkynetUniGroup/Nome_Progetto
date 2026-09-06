import { test, expect } from '@playwright/test';

/**
 * TS/TA per la terza operazione implementata nel PoC, SECURITY_POLICY
 * (RF.92, RF.93, RF.70). End-to-end reale: nessun mock.
 *
 * Caso positivo: `IlGranz/codeguardian-e2e-fixture`, un repository di
 * prova pubblico creato apposta (con conferma esplicita dell'utente —
 * vedi TESTING.md) con un POLICY.md e un file JS con violazioni
 * intenzionali (segreto hardcoded, `eval()`, SQL injection).
 *
 * Due tentativi precedenti prima di arrivare qui, entrambi documentati
 * come scoperte reali in TESTING.md:
 * 1. `sigstore/sigstore` (Go) — bocciato dalla validazione del linguaggio
 *    (RV.7 richiede TS/JS/Python).
 * 2. `keldaanCommunity/pokemonAutoChess` (TypeScript, ma repository enorme)
 *    — ha rivelato un bug reale: l'albero file di GitHub viene troncato
 *    dall'API (>64205 nodi) e il backend non se ne accorge, causando un
 *    falso "POLICY.md non trovato" per un file che esiste per davvero.
 *
 * Caso negativo (RF.70/UC27.5): `OWASP/NodeGoat` non ha alcun POLICY.md —
 * verifica che l'assenza della risorsa venga gestita come errore
 * esplicito e non come crash silenzioso.
 */
const GITHUB_PAT = process.env.E2E_GITHUB_PAT;

test.describe('Flusso completo: Agente Security — verifica POLICY.md', () => {
  test.skip(!GITHUB_PAT, 'E2E_GITHUB_PAT non impostato nel .env — vedi TESTING.md');
  test.setTimeout(6 * 60_000);

  async function login(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.getByPlaceholder('ghp_xxxxxxxxxxxx...').fill(GITHUB_PAT!);
    await page.getByRole('button', { name: 'Salva e Inizia' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');
  }

  test('RF.92/93 — POLICY.md presente: la scansione completa e produce un report', async ({ page }) => {
    await login(page);

    await page.getByPlaceholder('skynetunigroup').fill('IlGranz');
    await page.getByPlaceholder('code_guardian').fill('codeguardian-e2e-fixture');
    await page.getByPlaceholder('main').fill('develop');
    await page.getByPlaceholder('es. Src/').fill('src');

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'SECURITY_POLICY' });
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();

    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
    await expect(page.getByText('Analisi completata!')).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByText('Analisi fallita')).not.toBeVisible();

    await page.getByRole('link', { name: 'Visualizza Report →' }).click();
    await expect(page.getByRole('heading', { name: 'Analisi: SECURITY_POLICY' })).toBeVisible();
    // Il file di fixture ha violazioni intenzionali (segreto hardcoded,
    // eval, SQL injection): ci aspettiamo che l'agente ne trovi almeno una,
    // non solo che l'analisi "non sia fallita".
    await expect(page.getByText('Dettagli')).toBeVisible();
  });

  test('RF.70/UC27.5 — POLICY.md assente: fallisce con un errore esplicito, non un crash', async ({ page }) => {
    await login(page);

    await page.getByPlaceholder('skynetunigroup').fill('OWASP');
    await page.getByPlaceholder('code_guardian').fill('NodeGoat');
    await page.getByPlaceholder('main').fill('master');
    await page.getByPlaceholder('es. Src/').fill(DIRECTORY_SORGENTE);

    await page.getByRole('button', { name: 'Carica operazioni disponibili' }).click();
    await page.getByRole('combobox').selectOption({ value: 'SECURITY_POLICY' });
    await page.getByRole('button', { name: 'Avvia Analisi' }).click();

    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
    await expect(page.getByText('Analisi fallita')).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByText('Analisi completata!')).not.toBeVisible();
  });
});

import { test, expect, type Page } from '@playwright/test';
import { vaiA, registraEAccedi, accediDalModulo, nuovoUtente, API, auth } from './helpers';

/**
 * Test di Sistema TS_79 – TS_81 (RF.79 – RF.81): template README
 * personalizzato per l'Agente Docs.
 *
 * Non richiedono né E2E_GITHUB_PAT né una LLM_API_KEY: il template è una
 * risorsa personale dell'utente, indipendente dal repository e
 * dall'esecuzione di un agente. La rotta /template infatti non è soggetta
 * alla guardia sulle credenziali, a differenza di /select e /run.
 */

const TEMPLATE_VALIDO = [
  '# {{project_name}}',
  '',
  '## Prerequisiti',
  '',
  '## Installazione',
  '',
  '## Licenza',
  '',
].join('\n');

/** Porta il browser sulla pagina del template, con un utente nuovo. */
async function apriTemplate(page: Page, request: any) {
  const { utente, token } = await registraEAccedi(request, nuovoUtente());
  await accediDalModulo(page, utente);
  await vaiA(page, 'Template');
  await expect(page.getByRole('heading', { name: 'Template README' })).toBeVisible();
  return token;
}

/** Sceglie un file nel campo di caricamento, come farebbe l'utente. */
async function caricaFile(page: Page, name: string, contenuto: string, mimeType = 'text/markdown') {
  await page.getByLabel(/Carica un template/).setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(contenuto, 'utf8'),
  });
}

test.describe('TS_79–TS_81 · Template README personalizzato', () => {
  test('TS_79 (RF.79) — l\'utente carica e salva un template personalizzato', async ({
    page,
    request,
  }) => {
    const token = await apriTemplate(page, request);

    // Si parte dal modello di default: è lo stato di chi non ha mai caricato nulla.
    await expect(page.getByText(/Nessun template personalizzato/)).toBeVisible();

    await caricaFile(page, 'mio-readme.md', TEMPLATE_VALIDO);

    // Il salvataggio è confermato a schermo e il nome del file resta visibile.
    await expect(page.getByRole('status')).toContainText('Template salvato');
    await expect(page.getByText('mio-readme.md')).toBeVisible();

    // E persiste davvero: non è solo stato di pagina.
    const risposta = await request.get(`${API}/templates/readme`, {
      headers: auth(token),
    });
    expect(risposta.ok()).toBeTruthy();
    const salvato = await risposta.json();
    expect(salvato.active).toBe(true);
    expect(salvato.filename).toBe('mio-readme.md');
    expect(salvato.content).toBe(TEMPLATE_VALIDO);
  });

  test('TS_80 (RF.80) — un file senza estensione .md viene rifiutato con un errore', async ({
    page,
    request,
  }) => {
    const token = await apriTemplate(page, request);

    await caricaFile(page, 'appunti.txt', TEMPLATE_VALIDO, 'text/plain');

    // L'errore dice *perché*: RF.80 chiede un messaggio, non un rifiuto muto.
    await expect(page.getByRole('alert')).toContainText('.md');

    // E nulla è stato salvato.
    const risposta = await request.get(`${API}/templates/readme`, {
      headers: auth(token),
    });
    expect((await risposta.json()).active).toBe(false);
  });

  test('TS_80b (RF.80) — un file .md vuoto viene rifiutato', async ({ page, request }) => {
    await apriTemplate(page, request);

    await caricaFile(page, 'vuoto.md', '   \n\t\n');

    await expect(page.getByRole('alert')).toContainText('vuoto');
  });

  test('TS_80c (RF.80) — un file binario rinominato .md viene rifiutato', async ({
    page,
    request,
  }) => {
    await apriTemplate(page, request);

    // Intestazione PNG: estensione giusta, contenuto che non è testo.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('latin1');
    await caricaFile(page, 'immagine.md', png);

    await expect(page.getByRole('alert')).toContainText('testo');
  });

  test('TS_80d (RF.80) — dopo un rifiuto il template precedente resta quello attivo', async ({
    page,
    request,
  }) => {
    await apriTemplate(page, request);
    await caricaFile(page, 'buono.md', TEMPLATE_VALIDO);
    await expect(page.getByText('buono.md')).toBeVisible();

    await caricaFile(page, 'cattivo.txt', TEMPLATE_VALIDO, 'text/plain');

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('buono.md')).toBeVisible();
  });

  test('TS_81 (RF.81) — la rimozione ripristina il modello di default', async ({
    page,
    request,
  }) => {
    const token = await apriTemplate(page, request);
    await caricaFile(page, 'da-rimuovere.md', TEMPLATE_VALIDO);
    await expect(page.getByText('da-rimuovere.md')).toBeVisible();

    await page.getByRole('button', { name: /Rimuovi template/ }).click();

    await expect(page.getByText(/Nessun template personalizzato/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Rimuovi template/ })).toHaveCount(0);

    // Lato backend il template non c'è più: l'Agente Docs tornerà al proprio
    // modello di default, che è esattamente l'assenza di un template.
    const risposta = await request.get(`${API}/templates/readme`, {
      headers: auth(token),
    });
    expect((await risposta.json()).active).toBe(false);
  });

  test('TS_81b (RF.79, RF.81) — il template di un altro utente non è visibile né rimovibile', async ({
    page,
    request,
  }) => {
    // Il template è personale: un secondo utente non deve vederlo, e la sua
    // rimozione non deve toccare quello del primo.
    const proprietario = await apriTemplate(page, request);
    await caricaFile(page, 'del-proprietario.md', TEMPLATE_VALIDO);
    await expect(page.getByText('del-proprietario.md')).toBeVisible();

    const { token: estraneo } = await registraEAccedi(request);

    const suo = await request.get(`${API}/templates/readme`, { headers: auth(estraneo) });
    expect((await suo.json()).active).toBe(false);

    await request.delete(`${API}/templates/readme`, { headers: auth(estraneo) });

    const delProprietario = await request.get(`${API}/templates/readme`, {
      headers: auth(proprietario),
    });
    expect((await delProprietario.json()).filename).toBe('del-proprietario.md');
  });
});

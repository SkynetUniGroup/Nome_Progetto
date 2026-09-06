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
  REPO,
  API,
  auth,
} from './helpers';

/**
 * Test di Sistema TS_49 – TS_64 e TS_73 – TS_74 (RF.49 – RF.64, RF.73 –
 * RF.74): archivio dei report, visualizzazione del contenuto ed
 * esportazione in PDF.
 *
 * TS_63 (collegamento alla Pull Request) è verificabile solo su un report
 * che l'abbia effettivamente aperta: è coperto in ts-agente-docs.spec.ts.
 */

const LLM = process.env.E2E_LLM_ENABLED === '1';

/**
 * Un frammento di testo che, se il blocco è stato davvero renderizzato,
 * deve comparire a schermo.
 *
 * Il campo scelto è quello che ogni renderer stampa in chiaro. Il taglio a
 * 60 caratteri tiene l'asserzione leggibile nel rapporto di errore senza
 * indebolirla: `toContainText` normalizza gli spazi, quindi il frammento
 * regge anche dove il layout manda a capo.
 */
function testoDistintivo(blocco: Record<string, string>): string {
  const campo =
    blocco.kind === 'TEXT'
      ? blocco.markdown
      : blocco.kind === 'CHANGELOG_ITEM'
        ? blocco.title
        : blocco.explanation;
  return campo.replace(/\s+/g, ' ').trim().slice(0, 60);
}

test.describe('TS_49–TS_64, TS_73–TS_74 · Report ed esportazione', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(
      !(await patSpendibile(request)),
      'richiede un E2E_GITHUB_PAT con lo scope "repo"',
    );
  });

  /**
   * Porta a termine un'analisi reale e restituisce il report prodotto.
   * L'ambito è ristretto a un file solo per contenere i tempi.
   */
  async function reportPronto(page: any, request: any) {
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
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible({ timeout: 240_000 });
    return token;
  }

  test('TS_49 (RF.49) — esiste un archivio storico dei report generati', async ({
    page,
    request,
  }) => {
    await reportPronto(page, request);

    await vaiA(page, 'Report');

    await expect(page.getByRole('heading', { name: 'Storico Report' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('TS_51 (RF.51) — ogni voce dell\'archivio mostra il proprio titolo', async ({
    page,
    request,
  }) => {
    await reportPronto(page, request);

    await vaiA(page, 'Report');

    // Il titolo è deterministico e composto dal backend — non generato dal
    // modello — come "<displayName> — owner/repo@branch"
    // (ReportAssemblyService.buildTitle). Asserire il titolo vero invece di
    // /\S/: quest'ultimo si accontentava della sola data, di un trattino o
    // perfino di un messaggio d'errore nella riga.
    const primaRiga = page.getByRole('row').nth(1);
    await expect(primaRiga).toContainText(
      `OWASP Top 10 vulnerability scan — ${REPO.owner}/${REPO.name}@${REPO.branch}`,
    );
  });

  test('TS_52 (RF.52) — ogni voce riporta data e ora di generazione', async ({ page, request }) => {
    await reportPronto(page, request);

    await vaiA(page, 'Report');

    await expect(page.getByRole('row').nth(1)).toContainText(/\d{2}\/\d{2}\/\d{4}/);
  });

  test('TS_50 (RF.50) — il codice identificativo del report non è mostrato in elenco', async ({
    page,
    request,
  }) => {
    // Requisito non soddisfatto dall'interfaccia attuale: l'identificativo
    // compare solo nell'indirizzo del collegamento, non come testo della
    // riga. Il test lo fissa per iscritto.
    await reportPronto(page, request);
    await vaiA(page, 'Report');

    const collegamento = page.getByRole('link', { name: /Visualizza/ }).first();
    const href = await collegamento.getAttribute('href');
    const id = href!.split('/').pop()!;

    await expect(page.getByRole('row').nth(1)).not.toContainText(id);
  });

  test('TS_53 (RF.53) — l\'utente seleziona un report e ne vede il contenuto', async ({
    page,
    request,
  }) => {
    await reportPronto(page, request);
    await vaiA(page, 'Report');

    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page).toHaveURL(/\/reports\/.+/);
    await expect(page.getByRole('button', { name: /Esporta PDF/ })).toBeVisible();
  });

  test('TS_54 (RF.54) — il report è diviso in intestazione e corpo', async ({ page, request }) => {
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    // Intestazione: operazione, stato, data. Corpo: il contenuto prodotto.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/Completato|Fallito/).first()).toBeVisible();
  });

  test('TS_58 (RF.58) — l\'intestazione riporta data e ora di completamento', async ({
    page,
    request,
  }) => {
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByText(/\d{2}\/\d{2}\/\d{4}/).first()).toBeVisible();
  });

  test('TS_57 (RF.57) — l\'intestazione riporta il tempo di esecuzione', async ({
    page,
    request,
  }) => {
    // La durata e' valorizzata solo su un report completato.
    test.skip(!LLM, "richiede E2E_LLM_ENABLED=1 e il servizio agenti attivo");
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByText(/\d+([.,]\d+)?s/).first()).toBeVisible();
  });

  test('TS_55–TS_56 (RF.55, RF.56) — repository e ambito non compaiono nell\'intestazione', async ({
    page,
    request,
  }) => {
    // Requisiti non soddisfatti: il report li conserva nel proprio contesto
    // ma l'intestazione mostra solo operazione, stato, data e durata.
    //
    // La stringa cercata è derivata da REPO, non scritta a mano: prima
    // l'asserzione era su 'NodeGoat', che nel percorso vivo non compare da
    // nessuna parte — i test operano sul fixture. Cercava l'assenza di
    // qualcosa che non poteva esserci, quindi sarebbe rimasta verde anche
    // il giorno in cui la UI avesse cominciato a mostrare il repository,
    // cioè proprio quando avrebbe dovuto avvisare.
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByText(REPO.name)).toHaveCount(0);
    await expect(page.getByText(REPO.owner)).toHaveCount(0);
  });

  test('TS_59 (RF.59) — il corpo mostra i blocchi di testo del report', async ({
    page,
    request,
  }) => {
    // Senza modello il report è FAILED e il corpo è vuoto: non c'è alcun
    // blocco su cui asserire. Prima il test se la cavava chiedendo che la
    // pagina contenesse "almeno un carattere non-spazio" — vero per
    // qualunque pagina renderizzata, compresa una pagina di errore.
    test.skip(!LLM, 'richiede E2E_LLM_ENABLED=1 e il servizio agenti attivo');
    const token = await reportPronto(page, request);

    // Il testo atteso è quello che il report contiene davvero, letto dalle
    // API: il corpo lo produce il modello, quindi non è scrivibile a mano,
    // ma una volta persistito è un dato deterministico su cui asserire.
    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    const [sommario] = await elenco.json();
    const dettaglio = await request.get(`${API}/reports/${sommario.id}`, {
      headers: auth(token),
    });
    const { body } = await dettaglio.json();
    expect(body.length).toBeGreaterThan(0);

    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    // Il contenuto testuale è renderizzato; la conversione del markdown in
    // elementi grafici non è invece implementata (TextBlockRenderer stampa
    // il sorgente in un <pre>).
    for (const blocco of body.slice(0, 3)) {
      await expect(page.locator('main').first()).toContainText(
        testoDistintivo(blocco),
      );
    }
  });

  test('TS_60–TS_62 (RF.60–RF.62) — i riscontri espongono categoria, gravità e posizione', async ({
    page,
    request,
  }) => {
    // Senza modello il report è FAILED e non contiene riscontri: non c'è
    // nulla su cui asserire. Va dichiarato saltato — con un `if` attorno al
    // corpo il test risultava "ok" senza eseguire una sola asserzione, e
    // quattro voci di catalogo (TS_60, TS_61, TS_62, TS_61b) si dichiaravano
    // coperte senza esserlo.
    test.skip(!LLM, 'richiede E2E_LLM_ENABLED=1 e il servizio agenti attivo');
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    // Categoria OWASP e badge di gravità sempre visibili, riferimento al
    // codice con file e righe.
    const riscontro = page.getByRole('button', { name: /righe \d+/ }).first();
    await expect(riscontro).toContainText(/righe \d+–\d+/);
    await expect(page.getByText(/Critico|Alto|Medio|Basso|Info/).first()).toBeVisible();

    // Spiegazione e rimedio si aprono su richiesta.
    await riscontro.click();
    await expect(page.getByText('Rimedio suggerito')).toBeVisible();
  });

  test('TS_61b (RF.61) — i riscontri si possono filtrare per gravità', async ({ page, request }) => {
    // Stessa ragione di TS_60–TS_62: il filtro per gravità esiste solo su un
    // report che abbia dei riscontri da filtrare.
    test.skip(!LLM, 'richiede E2E_LLM_ENABLED=1 e il servizio agenti attivo');
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByText(/Filtra per severità/)).toBeVisible();
    await page.getByRole('button', { name: 'Basso', exact: true }).click();

    // O restano solo i riscontri di quel livello, o si dichiara il vuoto.
    await expect(
      page
        .getByText('Nessun elemento per il filtro selezionato')
        .or(page.getByText(/righe \d+/).first()),
    ).toBeVisible();
  });

  test('TS_64 (RF.64) — il modulo di approvazione compare solo dove serve', async ({
    page,
    request,
  }) => {
    // Un report di sicurezza non richiede validazione umana: nessun comando
    // di conferma deve comparire. Il caso opposto è coperto dal Changelog.
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    await expect(page.getByRole('button', { name: /Conferma/ })).toHaveCount(0);
  });

  test('TS_73 (RF.73) — il report visualizzato può essere esportato in PDF', async ({
    page,
    request,
  }) => {
    test.skip(!LLM, "l'export rifiuta i report falliti: serve un'analisi completata");
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: /Esporta PDF/ }).click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('TS_73b (RF.73) — l\'endpoint di esportazione restituisce un PDF', async ({
    page,
    request,
  }) => {
    test.skip(!LLM, "l'export rifiuta i report falliti: serve un'analisi completata");
    const token = await reportPronto(page, request);
    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    const [report] = await elenco.json();

    const risposta = await request.get(`${API}/reports/${report.id}/export?format=pdf`, {
      headers: auth(token),
    });

    expect(risposta.ok()).toBeTruthy();
    expect(risposta.headers()['content-type']).toContain('pdf');
  });

  test('TS_74 (RF.74) — un\'anomalia durante l\'esportazione viene notificata', async ({
    page,
    request,
  }) => {
    await reportPronto(page, request);
    await vaiA(page, 'Report');
    await page.getByRole('link', { name: /Visualizza/ }).first().click();
    await page.route('**/reports/*/export*', (route) => route.fulfill({ status: 500 }));

    await page.getByRole('button', { name: /Esporta PDF/ }).click();

    await expect(page.getByText(/Errore durante il download del PDF/)).toBeVisible();
  });

  test("TS_74b (RF.74) — l'esportazione di un report fallito viene rifiutata", async ({
    page,
    request,
  }) => {
    // Un report FAILED non ha contenuto da impaginare: il contratto prevede
    // un 409 con corpo vuoto, non un PDF vuoto scaricato sul disco.
    const token = await reportPronto(page, request);
    const elenco = await request.get(`${API}/reports`, { headers: auth(token) });
    const [report] = await elenco.json();

    const risposta = await request.get(`${API}/reports/${report.id}/export?format=pdf`, {
      headers: auth(token),
    });

    expect(risposta.status()).toBe(409);
    expect(await risposta.text()).toBe('');
  });

  test('TS_53b (RF.53) — un report di un altro utente non è accessibile', async ({
    page,
    request,
  }) => {
    // Il proprietario porta a termine un'analisi vera. Prima il test si
    // limitava a salvargli una credenziale: nessun report veniva mai
    // generato, quindi l'elenco vuoto dell'estraneo era vero per
    // costruzione. Reggeva solo perché il database di sviluppo non viene
    // mai ripulito e conteneva report accumulati da esecuzioni precedenti;
    // su un database fresco — cioè in CI — non provava nulla.
    //
    // Non serve il modello: un report FAILED è comunque persistito e
    // elencabile (ReportAssemblyService lo compone anche per una task
    // fallita), ed è quanto basta a rendere l'isolamento osservabile.
    const proprietario = await reportPronto(page, request);
    const suoi = await request.get(`${API}/reports`, { headers: auth(proprietario) });
    const [report] = await suoi.json();
    expect(report).toBeDefined();

    const { token: estraneo } = await registraEAccedi(request);

    const elenco = await request.get(`${API}/reports`, { headers: auth(estraneo) });
    expect(await elenco.json()).toEqual([]);

    // Indovinare l'id non basta, e la risposta è 404: un 403 confermerebbe
    // che quel report esiste (contratto esplicito in reports.service.ts).
    const diretto = await request.get(`${API}/reports/${report.id}`, {
      headers: auth(estraneo),
    });
    expect(diretto.status()).toBe(404);
  });
});

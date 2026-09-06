import * as zlib from 'zlib';
import { composeReportPdf } from './report-pdf.composer';
import { ReportDto } from './dto/report.dto';

/**
 * Estrae il testo visibile da un PDF prodotto da pdfkit.
 *
 * Serve perché senza questo i test potevano solo dire "è un Buffer che
 * inizia per %PDF-", e un documento in cui non è stato disegnato niente
 * soddisfa comunque quella descrizione: RF.73 poteva regredire a foglio
 * bianco restando verde. Qui si legge il PDF vero, quello compresso che
 * esce in produzione — nessuna opzione di comodo attivata solo nei test.
 *
 * Come: gli stream FlateDecode vengono decompressi, e dai content stream
 * si raccolgono gli operatori di testo. pdfkit non emette `(...) Tj` ma
 * array `TJ` con i byte in esadecimale, spezzati dalle correzioni di
 * crenatura — `[<48656c6c6f> -20 <20776f726c64> 0] TJ` — quindi ogni
 * gruppo `<...>` va decodificato e ricongiunto. La codifica è WinAnsi
 * (CP1252): per i trattini lunghi e i punti mediani dell'intestazione non
 * coincide con latin1, e decodificarla male li trasformerebbe in caratteri
 * di controllo.
 */
function testoDelPdf(pdf: Buffer): string {
  const decodificatore = new TextDecoder('windows-1252');
  const grezzo = pdf.toString('latin1');
  let testo = '';

  const inizioStream = /stream\r?\n/g;
  let trovato: RegExpExecArray | null;
  while ((trovato = inizioStream.exec(grezzo)) !== null) {
    const da = trovato.index + trovato[0].length;
    const a = grezzo.indexOf('endstream', da);
    if (a < 0) continue;

    let contenuto: string;
    try {
      contenuto = zlib.inflateSync(pdf.subarray(da, a)).toString('latin1');
    } catch {
      // Stream non compresso o non inflatabile (font incorporati,
      // metadati): non è testo di pagina, non interessa.
      continue;
    }

    for (const arrayTJ of contenuto.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      for (const esadecimale of arrayTJ[1].matchAll(/<([0-9A-Fa-f]*)>/g)) {
        testo += decodificatore.decode(Buffer.from(esadecimale[1], 'hex'));
      }
      testo += '\n';
    }
  }

  // pdfkit manda a capo da solo quando una riga eccede la larghezza utile,
  // e le interruzioni cadono sugli spazi: appiattirle restituisce il testo
  // originale e permette di asserire frasi intere senza dover sapere dove
  // il layout ha deciso di spezzarle.
  return testo.replace(/\s+/g, ' ').trim();
}

function makeReport(overrides: Partial<ReportDto> = {}): ReportDto {
  return {
    id: 'report1',
    taskId: 'task1',
    operation: 'DOCS_README',
    status: 'COMPLETED',
    title: 'README generation/update — owner/repo@main',
    summary: null,
    durationMs: 1000,
    tokensConsumed: 42,
    generatedAt: '2026-01-01T00:00:00.000Z',
    context: {
      repoOwner: 'owner',
      repoName: 'repo',
      repoUrl: 'https://github.com/owner/repo',
      branch: 'main',
      resolvedSha: 'abcdef1234567890',
      scopeType: 'FULL_REPOSITORY',
      paths: [],
    },
    body: [],
    pendingAction: null,
    ...overrides,
  };
}

/** Un report che esercita ogni `kind` di blocco più la proposta. */
function reportCompleto(): ReportDto {
  return makeReport({
    summary: 'A short summary.',
    body: [
      { kind: 'TEXT', markdown: 'Some *markdown* text.' },
      {
        kind: 'FINDING',
        category: 'A03:2021',
        severity: 'high',
        filePath: 'src/x.ts',
        startLine: 1,
        endLine: 5,
        explanation: 'SQL injection.',
        remediationKind: 'TEXT',
        remediation: 'Use parameterized queries.',
      },
      {
        kind: 'POLICY_VIOLATION',
        ruleId: 'RULE-1',
        ruleText: 'No console.log in production code.',
        filePath: 'src/y.ts',
        explanation: 'Found a console.log.',
        severity: 'low',
        remediation: 'Remove it.',
      },
      {
        kind: 'COMPLEXITY_WARNING',
        filePath: 'src/z.ts',
        startLine: 10,
        endLine: 90,
        explanation: 'Function is too long.',
        severity: 'info',
      },
      {
        kind: 'CHANGELOG_ITEM',
        issueRef: 'ISS-42',
        title: 'Added feature X',
        detail: 'Implemented the thing.',
      },
    ],
    proposal: {
      targetPath: 'README.md',
      diffUnified: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n',
      language: 'markdown',
      pullRequestUrl: 'https://github.com/owner/repo/pull/1',
    },
  });
}

describe('composeReportPdf', () => {
  it('produces a non-empty buffer starting with the PDF magic bytes', async () => {
    const pdf = await composeReportPdf(makeReport());

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('prints the report title and the context line in the header', async () => {
    const testo = testoDelPdf(await composeReportPdf(makeReport()));

    expect(testo).toContain('README generation/update — owner/repo@main');
    expect(testo).toContain('FULL_REPOSITORY');
    // Lo sha viene abbreviato a 12 caratteri, non stampato per intero.
    expect(testo).toContain('main@abcdef123456');
    expect(testo).not.toContain('abcdef1234567890');
    expect(testo).toContain('generated 2026-01-01T00:00:00.000Z');
  });

  it('prints the summary when the report carries one', async () => {
    const testo = testoDelPdf(
      await composeReportPdf(makeReport({ summary: 'A short summary.' })),
    );

    expect(testo).toContain('A short summary.');
  });

  it('omits the summary when there is none', async () => {
    const testo = testoDelPdf(await composeReportPdf(makeReport({ summary: null })));

    expect(testo).not.toContain('A short summary.');
  });

  it('prints a TEXT block verbatim', async () => {
    const testo = testoDelPdf(await composeReportPdf(reportCompleto()));

    expect(testo).toContain('Some *markdown* text.');
  });

  it('prints severity, category, file position and remediation of a FINDING', async () => {
    const testo = testoDelPdf(await composeReportPdf(reportCompleto()));

    expect(testo).toContain('Finding — HIGH — A03:2021');
    expect(testo).toContain('src/x.ts:1-5');
    expect(testo).toContain('SQL injection.');
    expect(testo).toContain('Remediation:');
    expect(testo).toContain('Use parameterized queries.');
  });

  it('prints rule id, rule text and file of a POLICY_VIOLATION', async () => {
    const testo = testoDelPdf(await composeReportPdf(reportCompleto()));

    expect(testo).toContain('Policy violation — LOW — RULE-1');
    expect(testo).toContain('src/y.ts');
    expect(testo).toContain('No console.log in production code.');
    expect(testo).toContain('Found a console.log.');
    expect(testo).toContain('Remove it.');
  });

  it('prints the file span of a COMPLEXITY_WARNING', async () => {
    const testo = testoDelPdf(await composeReportPdf(reportCompleto()));

    expect(testo).toContain('Complexity warning');
    expect(testo).toContain('src/z.ts:10-90');
    expect(testo).toContain('Function is too long.');
  });

  it('prints issue reference, title and detail of a CHANGELOG_ITEM', async () => {
    const testo = testoDelPdf(await composeReportPdf(reportCompleto()));

    expect(testo).toContain('ISS-42 — Added feature X');
    expect(testo).toContain('Implemented the thing.');
  });

  it('prints the proposal target, its pull request URL and the diff', async () => {
    const testo = testoDelPdf(await composeReportPdf(reportCompleto()));

    expect(testo).toContain('Proposed change — README.md');
    expect(testo).toContain('Pull Request: https://github.com/owner/repo/pull/1');
    expect(testo).toContain('--- a/README.md');
    expect(testo).toContain('+++ b/README.md');
  });

  it('omits the pull request line for a proposal that has no URL yet', async () => {
    const report = reportCompleto();
    const testo = testoDelPdf(
      await composeReportPdf({
        ...report,
        proposal: { ...report.proposal!, pullRequestUrl: null },
      }),
    );

    expect(testo).toContain('Proposed change — README.md');
    expect(testo).not.toContain('Pull Request:');
  });

  it('still prints the header for an empty body and no proposal', async () => {
    const pdf = await composeReportPdf(makeReport({ body: [] }));
    const testo = testoDelPdf(pdf);

    expect(pdf).toBeInstanceOf(Buffer);
    expect(testo).toContain('README generation/update — owner/repo@main');
    expect(testo).not.toContain('Proposed change');
    expect(testo).not.toContain('Finding —');
  });
});

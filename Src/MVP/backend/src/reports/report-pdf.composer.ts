import PDFDocument from 'pdfkit';
import type { ReportDto } from './dto/report.dto';
import type { Block, Proposal } from './report.types';

// BE-20: composes the PDF programmatically from the persisted ReportDto —
// never from rendered HTML (the issue is explicit about this), so there's
// no headless-browser dependency and no risk of the screen rendering and
// the PDF ever drifting apart. Draws structured fields directly (severity,
// file path, line numbers as their own lines) rather than trying to
// interpret Markdown syntax — the Markdown was already sanitized once, at
// BE-18's boundary, as plain text; this is a plain-text typesetting of that
// same text, not a Markdown renderer.
//
// Resolves only once the document is fully drawn (doc.end() flushes the
// last 'data' chunk before 'finish'/pdfkit's readable stream ends) — the
// caller gets one complete Buffer, never a partial one to accidentally
// forward before generation actually finished.
export function composeReportPdf(report: ReportDto): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderHeader(doc, report);
      if (report.summary) {
        doc
          .moveDown()
          .fontSize(11)
          .font('Helvetica-Oblique')
          .text(report.summary);
        doc.font('Helvetica');
      }

      doc.moveDown();
      for (const block of report.body) {
        renderBlock(doc, block);
        doc.moveDown();
      }

      if (report.proposal) {
        renderProposal(doc, report.proposal);
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function renderHeader(doc: PDFKit.PDFDocument, report: ReportDto): void {
  doc.fontSize(18).font('Helvetica-Bold').text(report.title);
  doc.font('Helvetica');
  doc
    .fontSize(9)
    .fillColor('#555555')
    .text(
      `${report.context.scopeType} · ${report.context.branch}@${report.context.resolvedSha.slice(0, 12)} · generated ${report.generatedAt}`,
    );
  doc.fillColor('black');
}

function renderBlock(doc: PDFKit.PDFDocument, block: Block): void {
  switch (block.kind) {
    case 'TEXT':
      doc.fontSize(11).text(block.markdown);
      return;
    case 'FINDING':
      renderHeading(
        doc,
        `Finding — ${block.severity.toUpperCase()} — ${block.category}`,
      );
      renderMeta(doc, `${block.filePath}:${block.startLine}-${block.endLine}`);
      doc.fontSize(10).text(block.explanation);
      renderRemediation(doc, block.remediation, block.remediationLanguage);
      return;
    case 'POLICY_VIOLATION':
      renderHeading(
        doc,
        `Policy violation — ${block.severity.toUpperCase()} — ${block.ruleId}`,
      );
      renderMeta(doc, `${block.filePath} · ${block.ruleText}`);
      doc.fontSize(10).text(block.explanation);
      renderRemediation(doc, block.remediation);
      return;
    case 'COMPLEXITY_WARNING':
      renderHeading(doc, 'Complexity warning');
      renderMeta(doc, `${block.filePath}:${block.startLine}-${block.endLine}`);
      doc.fontSize(10).text(block.explanation);
      return;
    case 'CHANGELOG_ITEM':
      renderHeading(doc, `${block.issueRef} — ${block.title}`);
      doc.fontSize(10).text(block.detail);
      return;
  }
}

function renderProposal(doc: PDFKit.PDFDocument, proposal: Proposal): void {
  doc.moveDown();
  renderHeading(doc, `Proposed change — ${proposal.targetPath}`);
  if (proposal.pullRequestUrl) {
    renderMeta(doc, `Pull Request: ${proposal.pullRequestUrl}`);
  }
  doc.fontSize(9).font('Courier').text(proposal.diffUnified);
  doc.font('Helvetica');
}

function renderHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(13).font('Helvetica-Bold').text(text);
  doc.font('Helvetica');
}

function renderMeta(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(9).fillColor('#555555').text(text);
  doc.fillColor('black');
}

function renderRemediation(
  doc: PDFKit.PDFDocument,
  remediation: string,
  language?: string,
): void {
  doc
    .fontSize(9)
    .font('Helvetica-Bold')
    .text(`Remediation${language ? ` (${language})` : ''}:`);
  doc.font('Helvetica').fontSize(10).text(remediation);
}

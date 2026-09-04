import { composeReportPdf } from './report-pdf.composer';
import { ReportDto } from './dto/report.dto';

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

describe('composeReportPdf', () => {
  it('produces a non-empty buffer starting with the PDF magic bytes', async () => {
    const pdf = await composeReportPdf(makeReport());

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not throw for a report carrying every block kind plus a proposal', async () => {
    const report = makeReport({
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
        diffUnified:
          '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n',
        language: 'markdown',
        pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      },
    });

    const pdf = await composeReportPdf(report);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not throw for an empty body and no proposal', async () => {
    await expect(
      composeReportPdf(makeReport({ body: [] })),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

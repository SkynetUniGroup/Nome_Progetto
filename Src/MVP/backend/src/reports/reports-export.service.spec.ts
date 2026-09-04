jest.mock('./report-pdf.composer');

import { ReportsExportService } from './reports-export.service';
import { composeReportPdf } from './report-pdf.composer';

const composeReportPdfMock = composeReportPdf as jest.MockedFunction<
  typeof composeReportPdf
>;

function makeResponse() {
  const res: Record<string, jest.Mock> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as {
    status: jest.Mock;
    set: jest.Mock;
    end: jest.Mock;
    json: jest.Mock;
  };
}

function makeReportDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report1',
    operation: 'DOCS_README',
    status: 'COMPLETED',
    ...overrides,
  };
}

describe('ReportsExportService', () => {
  let service: ReportsExportService;
  let reportsService: { findOneForUser: jest.Mock };
  let storage: { putReportArtifact: jest.Mock };

  beforeEach(() => {
    reportsService = { findOneForUser: jest.fn() };
    storage = { putReportArtifact: jest.fn().mockResolvedValue(undefined) };
    composeReportPdfMock.mockReset();
    service = new ReportsExportService(
      reportsService as never,
      storage as never,
    );
  });

  it('lets a NotFoundException from ReportsService propagate unmodified (normal 404 flow)', async () => {
    const notFound = new Error('not found');
    reportsService.findOneForUser.mockRejectedValue(notFound);
    const res = makeResponse();

    await expect(service.export('user1', 'report1', res as never)).rejects.toBe(
      notFound,
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 409 with an empty body for a FAILED report, without composing anything', async () => {
    reportsService.findOneForUser.mockResolvedValue(
      makeReportDto({ status: 'FAILED' }),
    );
    const res = makeResponse();

    await service.export('user1', 'report1', res as never);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.end).toHaveBeenCalledWith(); // no argument — empty body
    expect(composeReportPdfMock).not.toHaveBeenCalled();
    expect(storage.putReportArtifact).not.toHaveBeenCalled();
  });

  it('composes, archives, and streams the PDF with the right headers and filename on success', async () => {
    const report = makeReportDto({ operation: 'SECURITY_OWASP', id: 'r42' });
    reportsService.findOneForUser.mockResolvedValue(report);
    const pdf = Buffer.from('%PDF-1.4 fake');
    composeReportPdfMock.mockResolvedValue(pdf);
    const res = makeResponse();

    await service.export('user1', 'r42', res as never);

    expect(composeReportPdfMock).toHaveBeenCalledWith(report);
    expect(storage.putReportArtifact).toHaveBeenCalledWith('r42', pdf);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename="code-guardian-SECURITY_OWASP-r42.pdf"',
      'Content-Length': String(pdf.length),
    });
    expect(res.end).toHaveBeenCalledWith(pdf);
  });

  it('responds 500 with EXPORT_FAILED when PDF composition throws, touching no Task/Report state', async () => {
    reportsService.findOneForUser.mockResolvedValue(makeReportDto());
    composeReportPdfMock.mockRejectedValue(new Error('pdfkit exploded'));
    const res = makeResponse();

    await service.export('user1', 'report1', res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      code: 'EXPORT_FAILED',
      message: 'pdfkit exploded',
    });
    expect(storage.putReportArtifact).not.toHaveBeenCalled();
  });

  it('responds 500 with EXPORT_FAILED when archiving to storage throws', async () => {
    reportsService.findOneForUser.mockResolvedValue(makeReportDto());
    composeReportPdfMock.mockResolvedValue(Buffer.from('%PDF-1.4'));
    storage.putReportArtifact.mockRejectedValue(
      new Error('bucket unreachable'),
    );
    const res = makeResponse();

    await service.export('user1', 'report1', res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      code: 'EXPORT_FAILED',
      message: 'bucket unreachable',
    });
    expect(res.end).not.toHaveBeenCalledWith(expect.any(Buffer));
  });
});

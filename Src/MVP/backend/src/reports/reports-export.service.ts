import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { ReportArtifactStorageService } from './report-artifact-storage.service';
import { composeReportPdf } from './report-pdf.composer';

// BE-20: deliberately bypasses the shared error envelope
// (AllExceptionsFilter / BE-2's error.code catalog) for its two
// special-cased responses — a FAILED report's 409 must have an empty body,
// and a generation failure's 500 must be exactly
// {code:'EXPORT_FAILED', message}, neither of which is what the global
// filter produces for a thrown HttpException (see AllExceptionsFilter:
// every branch there sets `code` from either AppException or a fixed
// status→code table, never a bespoke literal). Writing straight to the
// injected Response is how this method opts out of that machinery for just
// these two cases, on purpose.
//
// Not-found (ownership mismatch) is the one path that *does* go through the
// normal flow — ReportsService.findOneForUser's NotFoundException — nothing
// export-specific about a 404, so no reason to special-case it here too.
@Injectable()
export class ReportsExportService {
  private readonly logger = new Logger(ReportsExportService.name);

  constructor(
    private readonly reportsService: ReportsService,
    private readonly storage: ReportArtifactStorageService,
  ) {}

  async export(userId: string, id: string, res: Response): Promise<void> {
    const report = await this.reportsService.findOneForUser(userId, id);

    if (report.status === 'FAILED') {
      res.status(409).end();
      return;
    }

    try {
      // The whole PDF is built in memory before anything about the
      // response is touched — composeReportPdf only resolves once pdfkit's
      // stream has fully ended, so a failure partway through generation
      // throws here and never reaches the res.status(200) call below at
      // all, let alone transmits a truncated file.
      const pdf = await composeReportPdf(report);
      await this.storage.putReportArtifact(report.id, pdf);

      const filename = `code-guardian-${report.operation}-${report.id}.pdf`;
      res
        .status(200)
        .set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(pdf.length),
        })
        .end(pdf);
    } catch (err) {
      // No Task/Report state changed, no WebSocket event — this failure
      // family is deliberately outside BE-2's error.code catalog, so
      // nothing here touches either.
      this.logger.error(
        `PDF export failed for report ${id}`,
        err instanceof Error ? err.stack : String(err),
      );
      res.status(500).json({
        code: 'EXPORT_FAILED',
        message: err instanceof Error ? err.message : 'PDF export failed',
      });
    }
  }
}

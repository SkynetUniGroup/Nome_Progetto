// Integration test for GET /reports/:id/export, driven through a real HTTP
// request against the real ReportsController -> real ReportsExportService,
// with the real global ValidationPipe/AllExceptionsFilter registered — not
// just a service test with a hand-mocked Express Response.
//
// This exists because BE-20's two special-cased responses (409 empty body
// on FAILED, 500 {code:'EXPORT_FAILED', message} on generation failure) are
// deliberately built by writing straight to `res` instead of throwing, to
// bypass AllExceptionsFilter. reports-export.service.spec.ts only proves
// that *given a mocked Response object*, the service calls status()/json()/
// end() with the right arguments — it can't prove those calls actually
// reach the client unmodified once real Express/Nest machinery (the
// ValidationPipe, the globally-registered ExceptionFilter, header
// serialization) sits in front of them. A regression here — e.g. someone
// changing the try/catch to `throw new InternalServerErrorException(...)`
// instead of writing to `res` directly — would still pass every test in
// reports-export.service.spec.ts (a mocked res doesn't care who calls it)
// but would silently change the wire format, because AllExceptionsFilter's
// generic branch answers with {code:'UPSTREAM', message:'An internal error
// occurred.'} instead of {code:'EXPORT_FAILED', message:<real message>} —
// only a real filter, actually wired up, can catch that.
jest.mock('./report-pdf.composer');

import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsExportService } from './reports-export.service';
import { ReportArtifactStorageService } from './report-artifact-storage.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { composeReportPdf } from './report-pdf.composer';

const composeReportPdfMock = composeReportPdf as jest.MockedFunction<
  typeof composeReportPdf
>;

// Stands in for JwtAuthGuard: skips real passport/JWT verification (there is
// no AuthModule wired into this narrow test module) and attaches the same
// req.user shape JwtStrategy would, so @CurrentUser('userId') resolves the
// same way it does in production.
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { userId: 'user1', role: 'DEVELOPER' };
    return true;
  }
}

function makeReportDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report1',
    operation: 'DOCS_README',
    status: 'COMPLETED',
    ...overrides,
  };
}

describe('ReportsController (export, integration)', () => {
  let app: INestApplication<App>;
  let reportsService: { findOneForUser: jest.Mock };
  let storage: { putReportArtifact: jest.Mock };

  beforeEach(async () => {
    reportsService = { findOneForUser: jest.fn() };
    storage = { putReportArtifact: jest.fn().mockResolvedValue(undefined) };
    composeReportPdfMock.mockReset();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        // The real service, wired to real ReportsExportService — only its
        // two collaborators are mocked, exactly the boundary a real
        // deployment would have (Mongo, MinIO).
        ReportsExportService,
        { provide: ReportsService, useValue: reportsService },
        { provide: ReportArtifactStorageService, useValue: storage },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(FakeAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('responds 409 with a genuinely empty body for a FAILED report', async () => {
    reportsService.findOneForUser.mockResolvedValue(
      makeReportDto({ status: 'FAILED' }),
    );

    const res = await request(app.getHttpServer())
      .get('/reports/report1/export?format=pdf')
      .expect(409);

    expect(res.text).toBe('');
    expect(composeReportPdfMock).not.toHaveBeenCalled();
  });

  it('responds 500 with the literal EXPORT_FAILED shape when PDF generation fails, not the global error envelope', async () => {
    reportsService.findOneForUser.mockResolvedValue(makeReportDto());
    composeReportPdfMock.mockRejectedValue(new Error('pdfkit exploded'));

    const res = await request(app.getHttpServer())
      .get('/reports/report1/export?format=pdf')
      .expect(500);

    // Exact equality, not objectContaining: AllExceptionsFilter's own
    // fallback branch would answer {code:'UPSTREAM', message:'An internal
    // error occurred.'} — a superset match could pass on that shape too if
    // this test were loosened. This has to be exactly the bespoke body.
    expect(res.body).toEqual({
      code: 'EXPORT_FAILED',
      message: 'pdfkit exploded',
    });
  });

  it('still routes an ownership-mismatch 404 through the normal error envelope, unlike the two special cases', async () => {
    reportsService.findOneForUser.mockRejectedValue(
      new NotFoundException('Report report1 not found'),
    );

    const res = await request(app.getHttpServer())
      .get('/reports/report1/export?format=pdf')
      .expect(404);

    // AllExceptionsFilter's STATUS_FALLBACK_CODE shape — proves this path,
    // unlike FAILED/EXPORT_FAILED, is not special-cased in the controller.
    expect(res.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Report report1 not found',
    });
  });

  it('streams the composed PDF with the right headers and filename on success', async () => {
    reportsService.findOneForUser.mockResolvedValue(
      makeReportDto({ operation: 'SECURITY_OWASP', id: 'r42' }),
    );
    const pdf = Buffer.from('%PDF-1.4 fake pdf bytes');
    composeReportPdfMock.mockResolvedValue(pdf);

    const res = await request(app.getHttpServer())
      .get('/reports/r42/export?format=pdf')
      .expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="code-guardian-SECURITY_OWASP-r42.pdf"',
    );
    expect(Buffer.compare(res.body as Buffer, pdf)).toBe(0);
    expect(storage.putReportArtifact).toHaveBeenCalledWith('r42', pdf);
  });

  it('rejects an unsupported export format with the normal 400 validation envelope, before the service is called', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/report1/export?format=docx')
      .expect(400);

    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(reportsService.findOneForUser).not.toHaveBeenCalled();
  });
});

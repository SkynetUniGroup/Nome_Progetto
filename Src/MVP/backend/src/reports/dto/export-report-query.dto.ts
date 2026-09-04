import { IsIn } from 'class-validator';

// Query params for GET /reports/:id/export. 'pdf' is the only format the
// issue defines — an unsupported value is a plain 400 via the global
// ValidationPipe, same as anywhere else in this API.
export class ExportReportQueryDto {
  @IsIn(['pdf'])
  format: 'pdf';
}

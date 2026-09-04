import type { OperationCode } from '../../common/domain-types';
import type { ReportDocument } from '../schemas/report.schema';
import type { ReportStatus } from '../report.types';

// What GET /reports returns — deliberately thin (BE-19): no body, no
// proposal, no error, so listing a page of reports never pulls a
// potentially large Markdown/Block[] body over the wire just to render a
// list row.
export interface ReportSummaryDto {
  id: string;
  operation: OperationCode;
  status: ReportStatus;
  title: string;
  generatedAt: string;
}

export function toReportSummaryDto(report: ReportDocument): ReportSummaryDto {
  return {
    id: report.id,
    operation: report.operation,
    status: report.status,
    title: report.title,
    generatedAt: report.generatedAt.toISOString(),
  };
}

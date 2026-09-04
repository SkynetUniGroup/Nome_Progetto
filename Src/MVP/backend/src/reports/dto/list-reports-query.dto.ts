import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { OPERATION_CODES, type OperationCode } from '../../common/domain-types';

// Query params for GET /reports. userId is never one of them — it comes
// from the JWT (@CurrentUser), the same way every other list endpoint in
// this backend scopes itself to the caller.
export class ListReportsQueryDto {
  @IsOptional()
  @IsIn(OPERATION_CODES)
  operation?: OperationCode;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

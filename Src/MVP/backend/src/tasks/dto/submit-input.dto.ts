import { IsIn, IsString, ValidateIf } from 'class-validator';

// Body of POST /tasks/:id/input (BE-17). Mirrors PendingInput's three kinds
// as one discriminated union in the frontend's own types — flattened into a
// single class here because class-validator has no native support for
// validating a TS discriminated union directly; @ValidateIf per field is the
// standard way to keep the "which fields matter" rule attached to the field
// it governs instead of a hand-written validator.
export class SubmitInputDto {
  @IsIn(['SPRINT_ID', 'INCOMPLETE_TASKS', 'BUSINESS_CONFIRMATION'])
  kind: 'SPRINT_ID' | 'INCOMPLETE_TASKS' | 'BUSINESS_CONFIRMATION';

  // Only meaningful — and only validated — when kind is SPRINT_ID: the
  // value itself, not a yes/no confirmation.
  @ValidateIf((dto: SubmitInputDto) => dto.kind === 'SPRINT_ID')
  @IsString()
  sprintId?: string;

  // Only meaningful — and only validated — for the two resume kinds
  // (INCOMPLETE_TASKS, BUSINESS_CONFIRMATION): a plain confirmation, never
  // present alongside SPRINT_ID.
  @ValidateIf(
    (dto: SubmitInputDto) =>
      dto.kind === 'INCOMPLETE_TASKS' || dto.kind === 'BUSINESS_CONFIRMATION',
  )
  @IsIn(['PROCEED', 'CANCEL'])
  action?: 'PROCEED' | 'CANCEL';
}

import { IsIn, IsInt, IsMongoId, IsOptional, Min } from "class-validator";

export class InternalIssuesRequestDto {
  @IsMongoId()
  taskId!: string;

  // Present -> fetch that one issue's detail. Absent -> list issues,
  // filtered by `state` below.
  @IsOptional()
  @IsInt()
  @Min(1)
  issueNumber?: number;

  @IsOptional()
  @IsIn(["open", "closed", "all"])
  state?: "open" | "closed" | "all";
}

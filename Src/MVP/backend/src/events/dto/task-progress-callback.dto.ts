import { IsInt, IsString, Max, Min } from "class-validator";

// Body of POST /internal/tasks/:id/progress — the agent service reporting
// mid-execution progress (PoC §7.5). taskId itself travels as the :id path
// param, not in this body.
export class TaskProgressCallbackDto {
  @IsString()
  stage!: string;

  @IsInt()
  @Min(0)
  @Max(100)
  percent!: number;
}

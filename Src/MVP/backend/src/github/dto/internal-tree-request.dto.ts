import { IsMongoId } from "class-validator";

export class InternalTreeRequestDto {
  @IsMongoId()
  taskId!: string;
}

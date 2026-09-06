import { IsMongoId, IsNotEmpty, IsString } from "class-validator";

export class InternalFileRequestDto {
  @IsMongoId()
  taskId!: string;

  @IsString()
  @IsNotEmpty()
  path!: string;
}

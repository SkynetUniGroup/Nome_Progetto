import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { USER_ROLES, type UserRole } from "../schemas/user.schema";

export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  lastName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: "password must contain at least one letter and one digit",
  })
  password!: string;

  @IsIn(USER_ROLES)
  role!: UserRole;
}

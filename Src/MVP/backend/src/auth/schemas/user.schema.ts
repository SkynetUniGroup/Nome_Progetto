import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export type UserRole = "DEVELOPER" | "SECURITY_AUDITOR" | "PROJECT_MANAGER";

// The one place the three role values are listed as data, not just as a
// type — used by RegisterDto's validation so the allowed set can't drift
// from this type without a compile error.
export const USER_ROLES: UserRole[] = ["DEVELOPER", "SECURITY_AUDITOR", "PROJECT_MANAGER"];

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  email!: string;

  @Prop({ required: true })
  firstName!: string;

  @Prop({ required: true })
  lastName!: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ type: String, required: true })
  role!: UserRole;
}

export const UserSchema = SchemaFactory.createForClass(User);

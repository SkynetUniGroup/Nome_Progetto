import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export type ServiceCredentialDocument = HydratedDocument<ServiceCredential>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ServiceCredential {
  @Prop({ required: true })
  userId!: string;

  // Free string, not a closed enum — validated against a runtime whitelist
  // in code, not by the schema (§4.1).
  @Prop({ required: true })
  provider!: string;

  @Prop({ type: Buffer, required: true })
  ciphertext!: Buffer;

  @Prop({ type: Buffer, required: true })
  iv!: Buffer;

  @Prop({ type: Buffer, required: true })
  salt!: Buffer;

  @Prop({ type: Buffer, required: true })
  authTag!: Buffer;

  // Last successful validation, distinct from createdAt: re-validating an
  // already-saved credential (POST /credentials/:id/validate) updates this
  // without touching the ciphertext.
  @Prop({ required: true })
  connectedAt!: Date;
}

export const ServiceCredentialSchema = SchemaFactory.createForClass(ServiceCredential);

ServiceCredentialSchema.index({ userId: 1, provider: 1 }, { unique: true });

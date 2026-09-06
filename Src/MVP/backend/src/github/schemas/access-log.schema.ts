import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type AccessLogDocument = HydratedDocument<AccessLog>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AccessLog {
  // Required — every GitHub read the internal facade serves happens while
  // processing a specific Task; no documented scenario needs this absent.
  @Prop({ type: Types.ObjectId, ref: "Task", required: true })
  taskId!: Types.ObjectId;

  @Prop({ required: true })
  endpoint!: string;

  @Prop({ required: true })
  resource!: string;
}

export const AccessLogSchema = SchemaFactory.createForClass(AccessLog);

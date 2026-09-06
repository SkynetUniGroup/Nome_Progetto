import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export type UsageCounterDocument = HydratedDocument<UsageCounter>;

// One document per user per calendar month (RF.66). Incremented via an
// atomic upsert ($inc + upsert: true) when a Task is created, so two
// concurrent requests can't both read the same count and lose an increment.
@Schema()
export class UsageCounter {
  @Prop({ required: true })
  userId!: string;

  // "YYYY-MM" for the current calendar month.
  @Prop({ required: true })
  yearMonth!: string;

  @Prop({ required: true, default: 0 })
  count!: number;
}

export const UsageCounterSchema = SchemaFactory.createForClass(UsageCounter);
UsageCounterSchema.index({ userId: 1, yearMonth: 1 }, { unique: true });

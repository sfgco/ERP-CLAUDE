import { Schema, model } from 'mongoose';

/** Public holidays used by every SLA computation (CLAUDE.md "Business days"). */
const holidaySchema = new Schema(
  {
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD in Asia/Riyadh
    nameAr: { type: String, required: true },
    /** H3b T7: eid_fitr / eid_adha / national_day / founding_day / other — inferred from the name when absent. */
    kind: { type: String },
  },
  { timestamps: true },
);
export const Holiday = model('Holiday', holidaySchema);

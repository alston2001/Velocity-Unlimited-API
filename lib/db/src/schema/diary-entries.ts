import {
  index,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A single athlete-owned journal entry for a calendar day. Sentiment is
 * optional context for performance reflection, never a medical assessment.
 */
export const diaryEntriesTable = pgTable(
  "diary_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryDate: text("entry_date").notNull(),
    note: text("note").notNull(),
    sentiment: text("sentiment"),
    sentimentConfidence: real("sentiment_confidence"),
    sentimentSummary: text("sentiment_summary"),
    sentimentStatus: text("sentiment_status").notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("diary_entries_date_unique").on(t.entryDate),
    index("diary_entries_date_idx").on(t.entryDate),
  ],
);

export const insertDiaryEntrySchema = createInsertSchema(diaryEntriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDiaryEntry = z.infer<typeof insertDiaryEntrySchema>;
export type DiaryEntry = typeof diaryEntriesTable.$inferSelect;
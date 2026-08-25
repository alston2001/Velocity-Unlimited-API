import {
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Persisted VBT set records — the source of truth for CNS readiness and
 * motor readiness tracking across training sessions.
 *
 * The `first_rep_peak_ms` column is the most CNS-sensitive readiness marker
 * (Jovanovic & Flanagan, 2014); it is compared against a 21-day load-matched
 * baseline to produce the readiness score.
 */
export const setsTable = pgTable(
  "sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").defaultNow().notNull(),

    // Exercise context
    exerciseName: text("exercise_name").notNull(),
    weightKg: real("weight_kg").notNull(),
     plateDiameterMm: integer("plate_diameter_mm"),
     manualRepBoundsUsed: integer("manual_rep_bounds_used").notNull().default(0),
    // Only mobile_imu rows are eligible for readiness baselines. Legacy rows
    // remain queryable but are intentionally unclassified after migration.
    measurementSource: text("measurement_source").notNull().default("legacy_unclassified"),
    provenance: text("provenance").notNull().default("pre-provenance migration"),
    targetReps: integer("target_reps").notNull(),
    actualReps: integer("actual_reps").notNull(),

    // Primary velocity metrics
    meanVelocityMs: real("mean_velocity_ms").notNull(),
    peakVelocityMs: real("peak_velocity_ms").notNull(),

    /** First-rep peak velocity — key CNS readiness marker (nullable: may be absent if <2 reps detected) */
    firstRepPeakMs: real("first_rep_peak_ms"),

    // VBT enrichment
    estimated1RmPct: integer("estimated_1rm_pct").notNull(),
    velocityZone: text("velocity_zone").notNull(),
    velocityLossPct: real("velocity_loss_pct"),
    fatigueLevel: text("fatigue_level"),

    // Set metadata
    durationS: real("duration_s").notNull(),
    sampleCount: integer("sample_count").notNull(),
  },
  (t) => [
    // Primary query pattern: exercise history in time order
    index("sets_exercise_created_idx").on(t.exerciseName, t.createdAt),
    // CNS readiness queries: load-matched within a time window
    index("sets_exercise_weight_idx").on(t.exerciseName, t.weightKg, t.createdAt),
  ],
);

export const insertSetSchema = createInsertSchema(setsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertSet = z.infer<typeof insertSetSchema>;
export type SetRecord = typeof setsTable.$inferSelect;

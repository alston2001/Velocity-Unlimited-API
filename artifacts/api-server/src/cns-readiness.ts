/**
 * CNS Fatigue & Motor Readiness Engine
 *
 * Computes session-to-session readiness from persisted VBT set records.
 *
 * Literature basis:
 *  - Jovanovic & Flanagan (2014): first-rep peak velocity is the most
 *    CNS-sensitive VBT readiness marker.
 *  - González-Badillo et al. (2014/2020): velocity loss > 8% at sub-maximal
 *    loads indicates significant neuromuscular fatigue.
 *  - Weakley et al. (2020): load-matched velocity comparison is the most
 *    reliable readiness assessment protocol.
 *  - Pérez-Castilla et al. (2019): 21-day rolling baseline captures weekly
 *    periodization cycles without over-smoothing.
 *
 * Algorithm:
 *  1. Query last 21 days of sets for this exercise.
 *  2. Filter to ±15% of current load (load-matched comparison).
 *  3. If fewer than 3 matched sessions → score = null ("Insufficient data").
 *  4. Baseline = 21-day mean of first-rep peak velocities at matched load
 *     (falls back to mean velocity if first-rep data unavailable).
 *  5. Readiness ratio = today's first-rep peak / baseline.
 *  6. Score = ratio × 100, clamped [0, 100].
 *  7. Motor Readiness: High ≥95 · Moderate 85–94 · Low 70–84 · Compromised <70.
 *  8. Trend: linear slope of mean velocity over last 5 load-matched sessions.
 *     ±3% per-session threshold separates Rising / Stable / Declining.
 */

import { db, setsTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MotorReadinessLevel =
  | "High"
  | "Moderate"
  | "Low"
  | "Compromised"
  | "Insufficient data";

export type VelocityTrend =
  | "Rising"
  | "Stable"
  | "Declining"
  | "Insufficient data";

export interface ReadinessReport {
  /** 0–100 · null when fewer than MIN_SESSIONS load-matched sets exist. */
  score: number | null;
  level: MotorReadinessLevel;
  trend: VelocityTrend;
  /** Number of historical load-matched sessions used in the calculation. */
  dataPoints: number;
  /** The 21-day load-matched baseline first-rep peak used as the denominator. */
  baselineVelocityMs: number | null;
}

export interface HistoricalSetRow {
  id: string;
  createdAt: string;
  date: string;
  meanVelocityMs: number;
  peakVelocityMs: number;
  firstRepPeakMs: number | null;
  weightKg: number;
  estimated1RmPct: number;
  actualReps: number;
  velocityLossPct: number | null;
  fatigueLevel: string | null;
  measurementSource: string;
  provenance: string;
}

/** Case- and whitespace-stable identity for exercise-specific history queries. */
export function canonicalizeExerciseName(exerciseName: string): string {
  return exerciseName.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Load window for "matched" comparison (±15% of current weight). */
const LOAD_MATCH_BAND = 0.15;
/** Rolling window in days for baseline computation. */
const BASELINE_DAYS = 21;
/** Minimum load-matched sessions required to produce a meaningful score. */
const MIN_SESSIONS = 3;
/** Number of recent sessions to use for trend calculation. */
const TREND_SESSIONS = 5;
/** Session-to-session slope threshold to call a trend Rising or Declining (%). */
const TREND_THRESHOLD_PCT = 3;
export const TRUSTED_MEASUREMENT_SOURCE = "mobile_imu";
export const TRUSTED_CV_SOURCE = "computer_vision";

export function expectedMeasurementSource(exerciseName: string): string {
  return canonicalizeExerciseName(exerciseName) === "squat"
    ? TRUSTED_CV_SOURCE
    : TRUSTED_MEASUREMENT_SOURCE;
}

export function isTrustedMeasurementRow(row: Pick<HistoricalSetRow, "measurementSource" | "date"> & { exerciseName?: string }): boolean {
  if (row.measurementSource === TRUSTED_CV_SOURCE) return true;
  return row.measurementSource === TRUSTED_MEASUREMENT_SOURCE;
}

/**
 * Test fixtures, imports, and legacy rows can be retained for auditability,
 * but must never become an implicit readiness baseline.
 */
export function filterTrustedReadinessHistory(
  history: HistoricalSetRow[],
): HistoricalSetRow[] {
  return history.filter((row) => isTrustedMeasurementRow(row));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ordinary least-squares slope of `values` treated as equally-spaced x=0,1,…n-1.
 * Returns slope in same units as values, per index increment.
 */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (values[i]! - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

function classifyTrend(velocities: number[]): VelocityTrend {
  if (velocities.length < 3) return "Insufficient data";
  const baseline = velocities.reduce((a, b) => a + b, 0) / velocities.length;
  if (baseline === 0) return "Insufficient data";
  const slope = linearSlope(velocities);
  const pctPerSession = (slope / baseline) * 100;
  if (pctPerSession > TREND_THRESHOLD_PCT) return "Rising";
  if (pctPerSession < -TREND_THRESHOLD_PCT) return "Declining";
  return "Stable";
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

async function fetchHistory(
  exerciseName: string,
  days: number,
): Promise<HistoricalSetRow[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = (await db
    .select()
    .from(setsTable)
    .where(
      and(
        sql`lower(trim(${setsTable.exerciseName})) = ${canonicalizeExerciseName(exerciseName)}`,
        gte(setsTable.createdAt, since),
      ),
    )
    .orderBy(desc(setsTable.createdAt)))
    .filter((row) =>
      isTrustedMeasurementRow({
        measurementSource: row.measurementSource,
        date: row.createdAt.toISOString(),
      }) && row.measurementSource === expectedMeasurementSource(exerciseName),
    );

  return rows
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      date: r.createdAt.toISOString().split("T")[0]!,
      meanVelocityMs: r.meanVelocityMs,
      peakVelocityMs: r.peakVelocityMs,
      firstRepPeakMs: r.firstRepPeakMs ?? null,
      weightKg: r.weightKg,
      estimated1RmPct: r.estimated1RmPct,
      actualReps: r.actualReps,
      velocityLossPct: r.velocityLossPct ?? null,
      fatigueLevel: r.fatigueLevel ?? null,
      measurementSource: r.measurementSource,
      provenance: r.provenance,
    }))
    .filter(
      (row) =>
        Number.isFinite(row.meanVelocityMs) &&
        row.meanVelocityMs >= 0.05 &&
        row.meanVelocityMs <= 3 &&
        Number.isFinite(row.weightKg) &&
        row.weightKg > 0,
    );
}

export function selectLoadMatchedHistory(
  history: HistoricalSetRow[],
  currentWeightKg: number,
): HistoricalSetRow[] {
  const loadMin = currentWeightKg * (1 - LOAD_MATCH_BAND);
  const loadMax = currentWeightKg * (1 + LOAD_MATCH_BAND);
  return history.filter((row) => row.weightKg >= loadMin && row.weightKg <= loadMax);
}

export function computeReadinessFromHistory(
  allHistory: HistoricalSetRow[],
  currentWeightKg: number,
  currentFirstRepPeakMs: number | null,
): ReadinessReport & { history: HistoricalSetRow[]; matchedHistory: HistoricalSetRow[] } {
  const trustedHistory = filterTrustedReadinessHistory(allHistory);
  const matched = selectLoadMatchedHistory(trustedHistory, currentWeightKg);
  const dataPoints = matched.length;

  // Trend is useful as a descriptive signal even before a score is possible.
  const trendSource = matched.length >= MIN_SESSIONS ? matched : trustedHistory;
  const trendVels = trendSource
    .slice(0, TREND_SESSIONS)
    .reverse()
    .map((r) => r.meanVelocityMs);
  const trend = classifyTrend(trendVels);

  if (
    dataPoints < MIN_SESSIONS ||
    currentFirstRepPeakMs === null ||
    currentFirstRepPeakMs < 0.05
  ) {
    return {
      score: null,
      level: "Insufficient data",
      trend,
      dataPoints,
      baselineVelocityMs: null,
      history: trustedHistory,
      matchedHistory: matched,
    };
  }

  const withPeaks = matched.filter(
    (r) => r.firstRepPeakMs !== null && r.firstRepPeakMs > 0.05,
  );
  const useFirstRep = withPeaks.length >= MIN_SESSIONS;
  const baselineVelocityMs = useFirstRep
    ? withPeaks.reduce((sum, row) => sum + row.firstRepPeakMs!, 0) / withPeaks.length
    : matched.reduce((sum, row) => sum + row.meanVelocityMs, 0) / matched.length;
  const ratio = currentFirstRepPeakMs / baselineVelocityMs;
  const score = Math.min(100, Math.max(0, Math.round(ratio * 100)));

  let level: MotorReadinessLevel;
  if (score >= 95) level = "High";
  else if (score >= 85) level = "Moderate";
  else if (score >= 70) level = "Low";
  else level = "Compromised";

  return {
    score,
    level,
    trend,
    dataPoints,
    baselineVelocityMs: Math.round(baselineVelocityMs * 1000) / 1000,
    history: trustedHistory,
    matchedHistory: matched,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the CNS motor readiness report for an athlete's current set.
 *
 * @param exerciseName   The exercise being performed.
 * @param currentWeightKg  Load on the bar this session (kg).
 * @param currentFirstRepPeakMs  First-rep peak velocity from THIS set's sensor data.
 *                               Pass `null` if fewer than 1 rep was detected.
 */
export async function computeReadiness(
  exerciseName: string,
  currentWeightKg: number,
  currentFirstRepPeakMs: number | null,
): Promise<ReadinessReport & { history: HistoricalSetRow[]; matchedHistory: HistoricalSetRow[] }> {
  const allHistory = await fetchHistory(exerciseName, BASELINE_DAYS);
  return computeReadinessFromHistory(allHistory, currentWeightKg, currentFirstRepPeakMs);
}

/**
 * Format a text summary of recent sessions suitable for injection into
 * an AI coaching prompt.
 */
export function buildHistorySummary(
  history: HistoricalSetRow[],
  limit = 5,
): string | null {
  const recent = history.slice(0, limit);
  if (recent.length === 0) return null;
  return recent
    .map((s) => {
      const loss =
        s.velocityLossPct !== null
          ? ` | V-loss ${s.velocityLossPct.toFixed(1)}%`
          : "";
      return (
        `  ${s.date}: ${s.meanVelocityMs.toFixed(3)} m/s mean, ` +
        `${s.weightKg}kg (~${s.estimated1RmPct}%1RM), ${s.actualReps} reps${loss}`
      );
    })
    .join("\n");
}

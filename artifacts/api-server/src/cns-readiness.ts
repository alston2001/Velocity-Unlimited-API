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
import { and, desc, gte, lte, sql } from "drizzle-orm";

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
  date: string;
  meanVelocityMs: number;
  peakVelocityMs: number;
  firstRepPeakMs: number | null;
  weightKg: number;
  estimated1RmPct: number;
  actualReps: number;
  velocityLossPct: number | null;
  fatigueLevel: string | null;
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

  const rows = await db
    .select()
    .from(setsTable)
    .where(
      and(
        sql`lower(trim(${setsTable.exerciseName})) = ${canonicalizeExerciseName(exerciseName)}`,
        gte(setsTable.createdAt, since),
      ),
    )
    .orderBy(desc(setsTable.createdAt));

  return rows
    .map((r) => ({
      date: r.createdAt.toISOString().split("T")[0]!,
      meanVelocityMs: r.meanVelocityMs,
      peakVelocityMs: r.peakVelocityMs,
      firstRepPeakMs: r.firstRepPeakMs ?? null,
      weightKg: r.weightKg,
      estimated1RmPct: r.estimated1RmPct,
      actualReps: r.actualReps,
      velocityLossPct: r.velocityLossPct ?? null,
      fatigueLevel: r.fatigueLevel ?? null,
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
): Promise<ReadinessReport & { history: HistoricalSetRow[] }> {
  const allHistory = await fetchHistory(exerciseName, BASELINE_DAYS);

  // Load-matched subset (±15%)
  const loadMin = currentWeightKg * (1 - LOAD_MATCH_BAND);
  const loadMax = currentWeightKg * (1 + LOAD_MATCH_BAND);
  const matched = allHistory.filter(
    (r) => r.weightKg >= loadMin && r.weightKg <= loadMax,
  );

  const dataPoints = matched.length;

  // Determine trend regardless of whether we have enough for a score
  // (use ALL load-matched history for trend; fall back to unmatched if needed)
  const trendSource = matched.length >= 3 ? matched : allHistory;
  const trendVels = trendSource
    .slice(0, TREND_SESSIONS)
    .reverse()
    .map((r) => r.meanVelocityMs);
  const trend = classifyTrend(trendVels);

  // Insufficient data
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
      history: allHistory,
    };
  }

  // Baseline — prefer first-rep peaks, fall back to mean velocity
  const withPeaks = matched.filter(
    (r) => r.firstRepPeakMs !== null && r.firstRepPeakMs! > 0.05,
  );
  const useFirstRep = withPeaks.length >= MIN_SESSIONS;
  const baselineVelocityMs = useFirstRep
    ? withPeaks.reduce((s, r) => s + r.firstRepPeakMs!, 0) / withPeaks.length
    : matched.reduce((s, r) => s + r.meanVelocityMs, 0) / matched.length;

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
    history: allHistory,
  };
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

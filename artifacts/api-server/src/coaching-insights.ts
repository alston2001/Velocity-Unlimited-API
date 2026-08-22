import type { HistoricalSetRow } from "./cns-readiness.js";

export interface HistoricalComparison {
  baselineMeanVelocityMs: number | null;
  deltaPct: number | null;
  dataPoints: number;
  insight: string;
}

export interface DeterministicCoachingInput {
  historicalComparison: HistoricalComparison;
  velocityLossPct: number | null;
  fatigueLevel: string | null;
  cnsReadinessScore: number | null;
  motorReadinessLevel: string;
  baselineVelocityMs: number | null;
  diaryContext: string | null;
}

export function buildHistoricalComparison(
  exerciseName: string,
  weightKg: number,
  currentMeanMs: number,
  history: HistoricalSetRow[],
): HistoricalComparison {
  const loadMin = weightKg * 0.85;
  const loadMax = weightKg * 1.15;
  const matched = history.filter(
    (row) =>
      row.weightKg >= loadMin &&
      row.weightKg <= loadMax &&
      Number.isFinite(row.meanVelocityMs) &&
      row.meanVelocityMs > 0,
  );

  if (matched.length === 0) {
    return {
      baselineMeanVelocityMs: null,
      deltaPct: null,
      dataPoints: 0,
      insight: `No load-matched history is available for ${exerciseName} yet. Keep this load and use today's ${currentMeanMs.toFixed(3)} m/s mean as the first profile point; compare the next session before changing intensity.`,
    };
  }

  const baselineMeanVelocityMs =
    matched.reduce((sum, row) => sum + row.meanVelocityMs, 0) / matched.length;
  const deltaPct =
    ((currentMeanMs - baselineMeanVelocityMs) / baselineMeanVelocityMs) * 100;
  const roundedDelta = Math.round(deltaPct * 10) / 10;
  const direction =
    roundedDelta >= 0
      ? `${Math.abs(roundedDelta).toFixed(1)}% faster`
      : `${Math.abs(roundedDelta).toFixed(1)}% slower`;
  let action: string;
  if (roundedDelta >= 5) {
    action = "keep the same technique and only add load if the next set stays inside the target velocity zone";
  } else if (roundedDelta <= -5) {
    action = "add rest before the next set and consider reducing load 2–5% to return to the target velocity";
  } else {
    action = "hold the load steady and aim to repeat this velocity with consistent range of motion";
  }

  return {
    baselineMeanVelocityMs: Math.round(baselineMeanVelocityMs * 1000) / 1000,
    deltaPct: roundedDelta,
    dataPoints: matched.length,
    insight: `Today's ${currentMeanMs.toFixed(3)} m/s mean was ${direction} than the ${baselineMeanVelocityMs.toFixed(3)} m/s load-matched ${exerciseName} profile (${matched.length} session${matched.length === 1 ? "" : "s"}). For the next set, ${action}.`,
  };
}

export function buildDeterministicCoaching(ctx: DeterministicCoachingInput): string {
  const loss =
    ctx.velocityLossPct === null
      ? "Velocity loss is not available because fewer than two clear reps were measured."
      : `Velocity loss reached ${ctx.velocityLossPct.toFixed(1)}% (${ctx.fatigueLevel}).`;
  const readiness =
    ctx.cnsReadinessScore === null
      ? "There is not enough load-matched history to score readiness yet."
      : `Readiness is ${ctx.cnsReadinessScore}/100 (${ctx.motorReadinessLevel}) against the ${ctx.baselineVelocityMs?.toFixed(3) ?? "available"} m/s baseline.`;
  const diary = ctx.diaryContext
    ? `Diary context: ${ctx.diaryContext} This may help explain the day, but it does not establish cause or change the measured result.`
    : "";
  return `${ctx.historicalComparison.insight} ${loss} ${readiness} ${diary}`.trim();
}
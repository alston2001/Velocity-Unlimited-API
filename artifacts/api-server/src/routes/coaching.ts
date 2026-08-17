import { Router, type IRouter } from "express";
import { AnalyzeSetBody } from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db, setsTable } from "@workspace/db";
import {
  getProfile,
  estimateOneRmPct,
  getVelocityZone,
  calcVelocityLoss,
  extractRepPeaks,
} from "../vbt-profiles.js";
import {
  fetchAthleteSessions,
  isSparkdenConfigured,
} from "../sparkden-client.js";
import {
  computeReadiness,
  buildHistorySummary,
} from "../cns-readiness.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Velocity integration — trapezoidal rule on Z-axis (gravity-corrected)
// ---------------------------------------------------------------------------

function integrateVelocity(
  samples: { x: number; y: number; z: number; timestamp: number }[],
): { velocities: number[]; mean: number; peak: number } {
  if (samples.length < 2) {
    return { velocities: [], mean: 0, peak: 0 };
  }

  const gravityZ = samples[0]!.z;
  const velocities: number[] = [0];
  let velocity = 0;
  let sumAbsV = 0;
  let peak = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;
    const dt = (curr.timestamp - prev.timestamp) / 1000;
    if (dt <= 0) { velocities.push(velocity); continue; }

    const aPrev = (prev.z - gravityZ) * 9.81;
    const aCurr = (curr.z - gravityZ) * 9.81;
    velocity += 0.5 * (aPrev + aCurr) * dt;
    velocities.push(velocity);

    const absV = Math.abs(velocity);
    sumAbsV += absV;
    if (absV > peak) peak = absV;
  }

  const mean = sumAbsV / (samples.length - 1);
  return { velocities, mean, peak };
}

// ---------------------------------------------------------------------------
// AI coaching prompt
// ---------------------------------------------------------------------------

interface CoachingContext {
  exerciseName: string;
  weightKg: number;
  targetReps: number;
  totalSets: number;
  meanVelocityMs: number;
  peakVelocityMs: number;
  firstRepPeakMs: number | null;
  estimated1RmPct: number;
  velocityZone: string;
  velocityLossPct: number | null;
  fatigueLevel: string | null;
  mvt: number;
  durationS: number;
  historySummary: string | null;
  cnsReadinessScore: number | null;
  motorReadinessLevel: string;
  velocityTrend: string;
  baselineVelocityMs: number | null;
  readinessDataPoints: number;
}

async function generateCoachingFeedback(ctx: CoachingContext): Promise<string> {
  const historySection = ctx.historySummary
    ? `\nAthlete's recent history for this lift:\n${ctx.historySummary}`
    : "";

  const velocityLossLine =
    ctx.velocityLossPct !== null
      ? `Velocity loss across reps: ${ctx.velocityLossPct.toFixed(1)}% (${ctx.fatigueLevel})`
      : "Velocity loss: insufficient reps to calculate";

  const firstRepLine =
    ctx.firstRepPeakMs !== null
      ? `First-rep peak velocity: ${ctx.firstRepPeakMs.toFixed(3)} m/s`
      : "First-rep peak: not detected";

  const readinessSection =
    ctx.cnsReadinessScore !== null
      ? `
CNS Motor Readiness (vs. 21-day load-matched baseline):
- Readiness score: ${ctx.cnsReadinessScore}/100 (${ctx.motorReadinessLevel})
- Baseline first-rep peak: ${ctx.baselineVelocityMs?.toFixed(3) ?? "n/a"} m/s
- Session-to-session trend: ${ctx.velocityTrend} (based on ${ctx.readinessDataPoints} historical sessions)`
      : ctx.readinessDataPoints > 0
      ? `\nCNS Readiness: building baseline (${ctx.readinessDataPoints}/3 sessions tracked at this load)`
      : "\nCNS Readiness: no prior history at this load — today starts the baseline.";

  const systemPrompt = `You are a concise, data-driven velocity-based training (VBT) coach.
You communicate exactly like elite strength coaches who use tools like GymAware or PUSH Band in the real world.
Your feedback is direct, specific, and references actual velocity numbers.
When CNS readiness data is available, integrate it into your assessment — distinguish between within-session fatigue (velocity loss across reps) and between-session fatigue (CNS readiness vs. baseline).
Never use generic motivational language. Always ground feedback in the data provided.
Keep responses to 2–4 sentences maximum.`;

  const userPrompt = `Analyze this completed set and give coaching feedback:

Exercise: ${ctx.exerciseName}
Load: ${ctx.weightKg.toFixed(1)} kg
Target reps: ${ctx.targetReps} | Total sets planned: ${ctx.totalSets}
Set duration: ${ctx.durationS.toFixed(1)} s

Velocity metrics:
- Mean velocity: ${ctx.meanVelocityMs.toFixed(3)} m/s
- Peak velocity: ${ctx.peakVelocityMs.toFixed(3)} m/s
- ${firstRepLine}
- Training zone: ${ctx.velocityZone}
- Estimated %1RM: ~${ctx.estimated1RmPct}%
- Minimum velocity threshold (1RM) for this lift: ${ctx.mvt.toFixed(2)} m/s
- ${velocityLossLine}
${readinessSection}
${historySection}

Provide specific, actionable coaching feedback for the next set. Reference the velocity numbers directly. If readiness is Low or Compromised, factor that into load/intensity recommendations.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.6-luna",
    max_completion_tokens: 200,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "Unable to generate feedback.";
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/", (_req, res) => {
  const status = isSparkdenConfigured()
    ? "Sparkden connected."
    : "Sparkden keys missing.";
  res.type("text/plain").send(`Freelocity API is live! ${status}`);
});

router.post("/analyze-set", async (req, res) => {
  const parsed = AnalyzeSetBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      message: "Invalid request body",
      issues: parsed.error.issues,
    });
    return;
  }

  const { exercise_name, weight_kg, target_reps, total_sets, samples } =
    parsed.data;

  // 1. Integrate velocity
  const { velocities, mean, peak } = integrateVelocity(samples);

  const durationS =
    samples.length >= 2
      ? (samples[samples.length - 1]!.timestamp - samples[0]!.timestamp) / 1000
      : 0;

  // 2. VBT profile enrichment
  const profile = getProfile(exercise_name);
  const estimated1RmPct = estimateOneRmPct(mean, profile);
  const velocityZone = getVelocityZone(mean);

  const repPeaks = extractRepPeaks(velocities);
  const firstRepPeakMs = repPeaks.length > 0 ? (repPeaks[0] ?? null) : null;
  const lossResult = calcVelocityLoss(repPeaks);
  const velocityLossPct = lossResult?.lossPercent ?? null;
  const fatigueLevel = lossResult?.fatigue ?? null;
  const actualReps = repPeaks.length;

  // 3. CNS motor readiness — query against prior persisted sets
  const readinessResult = await computeReadiness(
    exercise_name,
    weight_kg,
    firstRepPeakMs,
  );

  // 4. Build history summary from DB records (primary) or Sparkden (fallback)
  let historySummary: string | null = buildHistorySummary(readinessResult.history);
  let sparkdenHistoryUsed = false;

  if (!historySummary && isSparkdenConfigured()) {
    try {
      const sessions = await fetchAthleteSessions(exercise_name, 5);
      if (sessions.length > 0) {
        const lines = sessions.map(
          (s) =>
            `  ${s.date}: ${s.mean_velocity_ms.toFixed(3)} m/s mean, ` +
            `${s.load_kg} kg (~${s.estimated_1rm_pct}% 1RM), ${s.reps} reps`,
        );
        historySummary = lines.join("\n");
        sparkdenHistoryUsed = true;
      }
    } catch {
      // Sparkden unavailable — continue without history
    }
  }

  // 5. AI coaching text (includes CNS readiness context)
  const aiFeedback = await generateCoachingFeedback({
    exerciseName: exercise_name,
    weightKg: weight_kg,
    targetReps: target_reps,
    totalSets: total_sets,
    meanVelocityMs: mean,
    peakVelocityMs: peak,
    firstRepPeakMs,
    estimated1RmPct,
    velocityZone,
    velocityLossPct,
    fatigueLevel,
    mvt: profile.mvt,
    durationS,
    historySummary,
    cnsReadinessScore: readinessResult.score,
    motorReadinessLevel: readinessResult.level,
    velocityTrend: readinessResult.trend,
    baselineVelocityMs: readinessResult.baselineVelocityMs,
    readinessDataPoints: readinessResult.dataPoints,
  });

  // 6. Persist this set for future readiness calculations
  try {
    await db.insert(setsTable).values({
      exerciseName: exercise_name,
      weightKg: weight_kg,
      targetReps: target_reps,
      actualReps,
      meanVelocityMs: Math.round(mean * 1000) / 1000,
      peakVelocityMs: Math.round(peak * 1000) / 1000,
      firstRepPeakMs: firstRepPeakMs !== null ? Math.round(firstRepPeakMs * 1000) / 1000 : null,
      estimated1RmPct,
      velocityZone,
      velocityLossPct,
      fatigueLevel,
      durationS: Math.round(durationS * 10) / 10,
      sampleCount: samples.length,
    });
  } catch (err) {
    // Persistence failure must not block the response — log and continue
    console.error("[sets] Failed to persist set:", err);
  }

  res.json({
    status: "success",
    exercise_name,
    mean_velocity_ms: Math.round(mean * 1000) / 1000,
    peak_velocity_ms: Math.round(peak * 1000) / 1000,
    first_rep_peak_ms: firstRepPeakMs !== null ? Math.round(firstRepPeakMs * 1000) / 1000 : null,
    estimated_1rm_pct: estimated1RmPct,
    velocity_zone: velocityZone,
    velocity_loss_pct: velocityLossPct,
    fatigue_level: fatigueLevel,
    sample_count: samples.length,
    duration_s: Math.round(durationS * 10) / 10,
    ai_feedback: aiFeedback,
    sparkden_history_used: sparkdenHistoryUsed,
    cns_readiness_score: readinessResult.score,
    motor_readiness_level: readinessResult.level,
    velocity_trend: readinessResult.trend,
    readiness_data_points: readinessResult.dataPoints,
    baseline_velocity_ms: readinessResult.baselineVelocityMs,
  });
});

export default router;

import { Router, type IRouter } from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const DEMO_HISTORY_PATHS = [
  resolve(process.cwd(), "previous_sets.json"),
  resolve(process.cwd(), "../../previous_sets.json"),
];

// ---------------------------------------------------------------------------
// Velocity integration — trapezoidal rule, axis selected by placement
// ---------------------------------------------------------------------------

type PhonePlacement = "weight_stack" | "barbell" | "pocket";
type DisplayUnit = "imperial" | "metric";

/**
 * Extract the scalar "motion" acceleration from a sample, gravity-corrected.
 *
 * weight_stack / barbell: vertical Z-axis only (linear machine/bar path).
 * pocket: root-mean-square of all three axes minus 1 G gravity baseline.
 *   The gravity component direction is unknown when the phone is in a pocket,
 *   so we subtract the per-axis baseline from sample[0] and use the residual
 *   magnitude — this captures omnidirectional body movement cleanly.
 */
function extractAccel(
  curr: { x: number; y: number; z: number },
  baseline: { x: number; y: number; z: number },
  placement: PhonePlacement,
): number {
  if (placement === "pocket") {
    const dx = curr.x - baseline.x;
    const dy = curr.y - baseline.y;
    const dz = curr.z - baseline.z;
    const sign = dz >= 0 ? 1 : -1;
    return sign * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  // weight_stack or barbell — Z-axis (gravity-corrected)
  return curr.z - baseline.z;
}

function integrateVelocity(
  samples: { x: number; y: number; z: number; timestamp: number }[],
  placement: PhonePlacement = "weight_stack",
): { velocities: number[]; mean: number; peak: number; valid: boolean; reason?: string } {
  if (samples.length < 20) {
    return { velocities: [], mean: 0, peak: 0, valid: false, reason: "At least 20 timestamped samples are required." };
  }

  const baselineCount = Math.min(10, samples.length);
  const baseline = samples.slice(0, baselineCount).reduce(
    (sum, sample) => ({ x: sum.x + sample.x / baselineCount, y: sum.y + sample.y / baselineCount, z: sum.z + sample.z / baselineCount }),
    { x: 0, y: 0, z: 0 },
  );
  const velocities: number[] = [0];
  let velocity = 0;
  let sumAbsV = 0;
  let peak = 0;
  let activeSamples = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;
    const dt = (curr.timestamp - prev.timestamp) / 1000;
    if (dt <= 0 || dt > 0.25) {
      velocities.push(velocity);
      velocity = 0;
      continue;
    }

    const aPrev = extractAccel(prev, baseline, placement) * 9.81;
    const aCurr = extractAccel(curr, baseline, placement) * 9.81;
    const averageAccel = 0.5 * (aPrev + aCurr);
    if (Math.abs(averageAccel) < 0.45) {
      velocity = Math.abs(velocity) < 0.04 ? 0 : velocity * Math.exp(-8 * dt);
    } else {
      velocity = Math.max(-4, Math.min(4, velocity + averageAccel * dt));
      activeSamples++;
    }
    velocities.push(velocity);

    const absV = Math.abs(velocity);
    sumAbsV += absV;
    if (absV > peak) peak = absV;
  }

  if (activeSamples < 8) {
    return { velocities, mean: 0, peak: 0, valid: false, reason: "No significant calibrated movement was detected." };
  }
  const mean = sumAbsV / (samples.length - 1);
  return { velocities, mean, peak, valid: true };
}

// ---------------------------------------------------------------------------
// AI coaching prompt
// ---------------------------------------------------------------------------

const PLACEMENT_LABELS: Record<PhonePlacement, string> = {
  weight_stack: "Weight stack / pulley pin (machine & cable)",
  barbell: "Fixed to barbell / weight (free weights)",
  pocket: "Pocket (bodyweight & plyometrics)",
};

interface CoachingContext {
  exerciseName: string;
  weightKg: number;
  displayLoad: number;
  displayUnit: DisplayUnit;
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
  phonePlacement: PhonePlacement;
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

  const placementNote =
    ctx.phonePlacement === "pocket"
      ? `\nSensor placement: ${PLACEMENT_LABELS[ctx.phonePlacement]}. Velocity data reflects full-body displacement magnitude rather than a single bar axis — interpret zone and loss values accordingly; absolute numbers will differ from barbell-mounted data.`
      : `\nSensor placement: ${PLACEMENT_LABELS[ctx.phonePlacement]}.`;

  const userPrompt = `Analyze this completed set and give coaching feedback:

Exercise: ${ctx.exerciseName}
Load: ${ctx.displayLoad.toFixed(1)} ${ctx.displayUnit === "imperial" ? "lb" : "kg"} (canonical ${ctx.weightKg.toFixed(3)} kg for matching and calculations)
Target reps: ${ctx.targetReps} | Total sets planned: ${ctx.totalSets}
Set duration: ${ctx.durationS.toFixed(1)} s
${placementNote}

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

router.get("/history", (_req, res) => {
  try {
    const historyPath = DEMO_HISTORY_PATHS.find((candidate) => existsSync(candidate));
    if (!historyPath) {
      res.status(500).json({ status: "error", message: "Demo history file is missing" });
      return;
    }
    const rows = JSON.parse(readFileSync(historyPath, "utf8")) as Array<{
      id: string;
      setNumber: number;
      exercise: string;
      daysBeforeDemo: number;
      loadKg: number;
      targetReps: number;
      actualReps: number;
      meanRepTimeSec: number;
      velocityLossPct: number;
      displacementM: number | null;
      source: string;
      provenance: string;
    }>;

    if (!Array.isArray(rows) || rows.length !== 24) {
      res.status(500).json({ status: "error", message: "Demo history is invalid" });
      return;
    }

    res.json(rows.map((row) => ({
      id: row.id,
      setNumber: row.setNumber,
      exercise: row.exercise,
      daysBeforeDemo: row.daysBeforeDemo,
      loadKg: row.loadKg,
      targetReps: row.targetReps,
      actualReps: row.actualReps,
      meanRepTimeSec: row.meanRepTimeSec,
      velocityLossPct: row.velocityLossPct,
      displacementM: row.displacementM,
      source: row.source,
      provenance: row.provenance,
    })));
  } catch (error) {
    console.error("[history] Failed to load canonical demo history:", error);
    res.status(500).json({ status: "error", message: "Demo history unavailable" });
  }
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

  const { exercise_name, weight_kg, target_reps, total_sets, samples } = parsed.data;
  const requestWithUnits = parsed.data as typeof parsed.data & {
    display_unit?: DisplayUnit;
    display_load?: number;
  };
  const displayUnit = requestWithUnits.display_unit ?? "metric";
  const displayLoad = requestWithUnits.display_load ?? weight_kg;
  // The generated Zod v3 declaration loses the optional defaulted field,
  // although the runtime schema and OpenAPI contract both accept it.
  const phone_placement = (parsed.data as typeof parsed.data & {
    phone_placement?: PhonePlacement;
  }).phone_placement;

  const placement: PhonePlacement = (phone_placement as PhonePlacement) ?? "weight_stack";

  // 1. Integrate velocity (axis selected by placement)
  const integration = integrateVelocity(samples, placement);
  if (!integration.valid) {
    res.status(422).json({
      status: "invalid_measurement",
      message: integration.reason,
    });
    return;
  }
  const { velocities, mean, peak } = integration;

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
  if (actualReps === 0) {
    res.status(422).json({
      status: "invalid_measurement",
      message: "No complete movement cycle was detected; velocity was withheld.",
    });
    return;
  }

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
    displayLoad,
    displayUnit,
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
    phonePlacement: placement,
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
    actual_reps: actualReps,
    rep_peaks_ms: repPeaks.map((v) => Math.round(v * 1000) / 1000),
  });
});

export default router;

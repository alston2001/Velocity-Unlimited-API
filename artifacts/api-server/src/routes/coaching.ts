import { Router, type IRouter } from "express";
import {
  AnalyzeSetResponse,
  AnalyzeSetBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Velocity integration
// Trapezoidal rule: v[n] = v[n-1] + 0.5 * (a[n-1] + a[n]) * dt
// We integrate the Z-axis (vertical) by default; gravity offset is
// subtracted by using delta-a from the first sample as a rough baseline.
// ---------------------------------------------------------------------------
function integrateVelocity(
  samples: { x: number; y: number; z: number; timestamp: number }[],
): { mean: number; peak: number } {
  if (samples.length < 2) {
    return { mean: 0, peak: 0 };
  }

  // Gravity baseline from first sample (device assumed roughly stationary)
  const gravityZ = samples[0]!.z;

  let velocity = 0;
  let sumVelocity = 0;
  let peak = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;

    // dt in seconds
    const dt = (curr.timestamp - prev.timestamp) / 1000;
    if (dt <= 0) continue;

    // Net acceleration (remove gravity)
    const aPrev = (prev.z - gravityZ) * 9.81; // m/s²
    const aCurr = (curr.z - gravityZ) * 9.81;

    velocity += 0.5 * (aPrev + aCurr) * dt;
    const absV = Math.abs(velocity);
    sumVelocity += absV;
    if (absV > peak) peak = absV;
  }

  const mean = sumVelocity / (samples.length - 1);
  return { mean, peak };
}

function buildFeedback(mean: number, peak: number, targetReps: number): string {
  if (peak < 0.1) {
    return "No significant bar movement detected — make sure the phone is secured to the bar or weight stack before the set.";
  }
  if (mean > 0.8) {
    return `Explosive set! Mean velocity ${mean.toFixed(2)} m/s — peak ${peak.toFixed(2)} m/s. Excellent intent through all ${targetReps} reps.`;
  }
  if (mean > 0.5) {
    return `Good tempo. Mean velocity ${mean.toFixed(2)} m/s — peak ${peak.toFixed(2)} m/s. Keep this rhythm for your remaining sets.`;
  }
  if (mean > 0.25) {
    return `Moderate velocity (${mean.toFixed(2)} m/s mean). You may be grinding. Consider dropping weight 5–10% or cutting a rep.`;
  }
  return `Low bar speed detected (${mean.toFixed(2)} m/s mean, peak ${peak.toFixed(2)} m/s). High fatigue — rack the bar and rest fully before the next set.`;
}

router.get("/", (_req, res) => {
  const sparkdenConfigured = Boolean(
    process.env["VELOCITY_CLIENT_ID"] &&
      process.env["VELOCITY_CLIENT_SECRET"],
  );

  const message = sparkdenConfigured
    ? "Freelocity API is live! Sparkden connection is configured."
    : "Freelocity API is live! Sparkden keys are missing.";

  res.type("text/plain").send(message);
});

router.post("/analyze-set", (req, res) => {
  const parsed = AnalyzeSetBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      message: "Invalid request body",
      issues: parsed.error.issues,
    });
    return;
  }

  const { exercise_name, weight_kg, target_reps, samples } = parsed.data;

  const { mean, peak } = integrateVelocity(samples);
  const durationS =
    samples.length >= 2
      ? (samples[samples.length - 1]!.timestamp - samples[0]!.timestamp) /
        1000
      : 0;

  const aiFeedback = buildFeedback(mean, peak, target_reps);

  const data = AnalyzeSetResponse.parse({
    status: "success",
    exercise_name,
    mean_velocity_ms: Math.round(mean * 1000) / 1000,
    peak_velocity_ms: Math.round(peak * 1000) / 1000,
    sample_count: samples.length,
    duration_s: Math.round(durationS * 10) / 10,
    ai_feedback: aiFeedback,
  });

  res.json(data);
});

export default router;

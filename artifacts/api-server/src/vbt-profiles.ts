/**
 * Velocity-Based Training (VBT) exercise profiles derived from peer-reviewed research.
 *
 * Sources:
 *  - Gonzalez-Badillo & Sanchez-Medina (2010) — Load-velocity relationship in squat
 *  - Sanchez-Medina et al. (2010) — Bench press load-velocity
 *  - Pareja-Blanco et al. (2017) — Velocity loss thresholds
 *  - Bossi et al. (2020) — Velocity zones practical framework
 */

export type VelocityZone =
  | "Maximal Strength"     // < 0.35 m/s  — > ~90% 1RM
  | "Strength-Speed"       // 0.35–0.75 m/s — ~75–90% 1RM
  | "Speed-Strength"       // 0.75–1.00 m/s — ~60–75% 1RM
  | "Power / Starting"     // > 1.00 m/s  — < ~60% 1RM
  | "No movement";

export type FatigueLevel =
  | "Fresh — more in the tank"
  | "Moderate — productive stimulus"
  | "High — approaching failure"
  | "Critical — stop the set";

export interface ExerciseProfile {
  /** Theoretical velocity at zero load (m/s) — the y-intercept of the load-velocity line */
  v0: number;
  /** Minimum Velocity Threshold — velocity at true 1RM (m/s) */
  mvt: number;
  /** Canonical names / aliases for fuzzy matching */
  names: string[];
}

// ---------------------------------------------------------------------------
// Published exercise profiles
// ---------------------------------------------------------------------------
const PROFILES: ExerciseProfile[] = [
  { v0: 1.62, mvt: 0.30, names: ["squat", "back squat", "front squat", "low bar", "high bar"] },
  { v0: 1.37, mvt: 0.16, names: ["bench", "bench press", "flat bench", "incline bench"] },
  { v0: 1.18, mvt: 0.13, names: ["deadlift", "conventional deadlift", "sumo deadlift", "romanian deadlift", "rdl"] },
  { v0: 1.20, mvt: 0.17, names: ["overhead press", "ohp", "military press", "shoulder press", "push press"] },
  { v0: 1.45, mvt: 0.25, names: ["hip thrust", "barbell hip thrust", "glute bridge"] },
  { v0: 1.15, mvt: 0.15, names: ["pull up", "pull-up", "pullup", "chin up", "chin-up"] },
  { v0: 1.30, mvt: 0.20, names: ["row", "barbell row", "bent over row", "cable row", "pendlay row"] },
  { v0: 1.55, mvt: 0.28, names: ["lunge", "walking lunge", "split squat", "bulgarian"] },
  { v0: 1.40, mvt: 0.22, names: ["leg press", "hack squat"] },
  { v0: 1.25, mvt: 0.18, names: ["dip", "dips", "weighted dip"] },
];

const GENERIC_PROFILE: ExerciseProfile = { v0: 1.30, mvt: 0.20, names: ["generic"] };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Find the best-matching profile for a given exercise name. */
export function getProfile(exerciseName: string): ExerciseProfile {
  const lower = exerciseName.toLowerCase();
  let best: ExerciseProfile | undefined;
  let bestScore = 0;

  for (const profile of PROFILES) {
    for (const alias of profile.names) {
      if (lower === alias) return profile; // exact match wins immediately
      if (lower.includes(alias) || alias.includes(lower)) {
        const score = alias.length; // longer match = more specific
        if (score > bestScore) {
          bestScore = score;
          best = profile;
        }
      }
    }
  }

  return best ?? GENERIC_PROFILE;
}

/**
 * Estimate %1RM from mean propulsive velocity using the linear load-velocity model:
 *   %1RM = (1 − v / V0) / (1 − MVT / V0) × 100
 * Returns a value clamped to [0, 100].
 */
export function estimateOneRmPct(meanVelocity: number, profile: ExerciseProfile): number {
  if (meanVelocity <= profile.mvt) return 100;
  if (meanVelocity >= profile.v0) return 0;
  const pct = ((1 - meanVelocity / profile.v0) / (1 - profile.mvt / profile.v0)) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Classify a velocity reading into a standard VBT training zone. */
export function getVelocityZone(meanVelocity: number): VelocityZone {
  if (meanVelocity < 0.05) return "No movement";
  if (meanVelocity < 0.35) return "Maximal Strength";
  if (meanVelocity < 0.75) return "Strength-Speed";
  if (meanVelocity < 1.00) return "Speed-Strength";
  return "Power / Starting";
}

/**
 * Calculate velocity loss between the first rep peak and the last rep peak.
 * Reps are detected by splitting the velocity trace into windows and finding
 * local maxima. Returns null if fewer than 2 clear peaks are found.
 */
export function calcVelocityLoss(
  repPeaks: number[],
): { lossPercent: number; fatigue: FatigueLevel } | null {
  if (repPeaks.length < 2) return null;
  const first = repPeaks[0]!;
  const last = repPeaks[repPeaks.length - 1]!;
  if (first < 0.05) return null;

  const lossPercent = Math.max(0, ((first - last) / first) * 100);

  let fatigue: FatigueLevel;
  if (lossPercent < 10) {
    fatigue = "Fresh — more in the tank";
  } else if (lossPercent < 20) {
    fatigue = "Moderate — productive stimulus";
  } else if (lossPercent < 35) {
    fatigue = "High — approaching failure";
  } else {
    fatigue = "Critical — stop the set";
  }

  return { lossPercent: Math.round(lossPercent * 10) / 10, fatigue };
}

/**
 * Split a continuous velocity trace into per-rep peak values.
 * Uses a simple threshold-crossing approach: a new rep starts when velocity
 * crosses up through `threshold` after previously dropping below it.
 */
export function extractRepPeaks(
  velocities: number[],
  threshold = 0.1,
): number[] {
  const peaks: number[] = [];
  let inRep = false;
  let repPeak = 0;

  for (const v of velocities) {
    const absV = Math.abs(v);
    if (!inRep && absV > threshold) {
      inRep = true;
      repPeak = absV;
    } else if (inRep) {
      if (absV > repPeak) {
        repPeak = absV;
      } else if (absV < threshold) {
        peaks.push(repPeak);
        repPeak = 0;
        inRep = false;
      }
    }
  }
  if (inRep && repPeak > 0) peaks.push(repPeak);

  return peaks;
}

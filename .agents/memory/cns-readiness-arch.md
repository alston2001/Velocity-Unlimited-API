---
name: CNS Readiness Architecture
description: How CNS fatigue and motor readiness tracking is implemented — DB schema, scoring algorithm, API fields, and mobile UI card.
---

## Rule
Every set is persisted to the `sets` table in the Drizzle/PostgreSQL DB. The CNS readiness score is computed at the end of `/analyze-set` by comparing today's first-rep peak velocity against a 21-day load-matched baseline from persisted history.

## Why
First-rep peak velocity is the most CNS-sensitive VBT marker (Jovanovic & Flanagan 2014). Load-matching (±15% band) isolates neuromuscular state from load effects. 21-day window captures a full periodization cycle without over-smoothing.

## Key files
- `lib/db/src/schema/sets.ts` — `setsTable` with `first_rep_peak_ms`, indexed on (exercise_name, created_at) and (exercise_name, weight_kg, created_at)
- `artifacts/api-server/src/cns-readiness.ts` — `computeReadiness()`, `buildHistorySummary()`, `linearSlope()`, `classifyTrend()`
- `artifacts/api-server/src/routes/coaching.ts` — persists set AFTER computing readiness (so this set doesn't inflate its own score)

## Scoring algorithm
1. Fetch last 21 days for the exercise name (ILIKE match)
2. Filter to ±15% of current weight → "matched" set
3. If matched < 3 OR first_rep_peak_ms < 0.05 m/s → score = null, level = "Insufficient data"
4. Baseline = mean of first_rep_peak_ms across matched (falls back to mean_velocity_ms if <3 sessions have first-rep data)
5. score = clamp(round(currentFirstRepPeak / baseline × 100), 0, 100)
6. Level: High ≥95 · Moderate 85–94 · Low 70–84 · Compromised <70

## Trend algorithm
- Take last 5 load-matched sessions, chronological order, extract mean_velocity_ms
- OLS slope; if slope / mean > +3% per session → Rising; < -3% → Declining; else Stable
- Falls back to all-exercise history if insufficient load-matched sessions

## API response fields (all new)
- `cns_readiness_score: number | null`
- `motor_readiness_level: string | null`
- `velocity_trend: string | null`
- `readiness_data_points: number`
- `baseline_velocity_ms: number | null`
- `first_rep_peak_ms: number | null`

## Mobile UI
- `ReadinessCard` component — shows score (0-100) with colour-coded bar, readiness level pill, trend badge, today's 1st-rep peak vs baseline
- "Building baseline" state: pip progress (X/3) when dataPoints < 3
- Positioned between secondary metrics row and AI coaching card in feedback phase

## How to apply
- After any codegen run, patch `zod.int()` → `zod.number().int()` (both api-zod and api-client-react generated files)
- DB migration runs via `pnpm --filter @workspace/db run push`
- Set persistence is fire-and-forget (catch block logs, does not block response)
- Sparkden history is still used as fallback if DB has no history for the exercise

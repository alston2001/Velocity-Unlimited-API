---
name: Phone placement architecture
description: How phone_placement flows from UI → API → velocity integration → AI prompt
---

## Rule
`phone_placement` is an enum (`weight_stack | barbell | pocket`) selected once per exercise on the setup form. It is required before the Continue button enables.

## How it flows
1. **Mobile** — `phonePlacement` state (null until selected). Sent as `phone_placement` in every `analyzeSet` API call. Shown in the ready-phase exercise summary. Reset to `null` on `handleNewExercise`.
2. **API** — `coaching.ts` extracts `phone_placement` from the validated body, casts to `PhonePlacement` type.
3. **Velocity integration** — `integrateVelocity(samples, placement)` calls `extractAccel()` per sample:
   - `weight_stack` / `barbell` → Z-axis only (linear bar path)
   - `pocket` → RMS magnitude of (curr − baseline) across all axes; sign taken from dZ
4. **AI prompt** — `placementNote` added to the user prompt; pocket mode includes a caveat that absolute values differ from barbell-mounted data.

**Why:** Pocket mode body movement is omnidirectional; a single-axis integral gives wrong/near-zero velocity for jumps and bodyweight movements.

**How to apply:** If you add a new placement mode, update `extractAccel()`, `PLACEMENT_LABELS`, and `PLACEMENT_OPTIONS` in both the API and mobile respectively.

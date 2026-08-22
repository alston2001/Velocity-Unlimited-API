---
name: Phone placement architecture
description: How phone_placement flows from UI → API → velocity integration → AI prompt
---

## Rule
The truthful live mobile path currently supports only a barbell-mounted phone using its Y axis. Other placement modes remain API capabilities, but are not offered as measured mobile tracking modes.

## How it flows
1. **Mobile** — the measured path sends `phone_placement: barbell` and uses the explicitly labeled Y axis. Rehearsal and uncalibrated paths never submit for coaching/readiness.
2. **API** — `coaching.ts` extracts `phone_placement` from the validated body, casts to `PhonePlacement` type.
3. **Velocity integration** — `integrateVelocity(samples, placement)` calls `extractAccel()` per sample:
    - `weight_stack` → Z-axis only (linear stack path)
    - `barbell` → Y-axis only, matching the currently supported mobile mount orientation
   - `pocket` → RMS magnitude of (curr − baseline) across all axes; sign taken from dZ
4. **AI prompt** — `placementNote` added to the user prompt; pocket mode includes a caveat that absolute values differ from barbell-mounted data.

**Why:** Pocket mode body movement is omnidirectional; a single-axis integral gives wrong/near-zero velocity for jumps and bodyweight movements. The live app deliberately narrows the supported contract instead of claiming equivalence for an unvalidated placement.

**How to apply:** If you add a new measured placement, update the mobile orientation/capture copy, `extractAccel()`, and the server-side validation/tests together. Never silently change the axis for an existing live contract.

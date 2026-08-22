# Freelocity Motion Tracker — Master System Specification

**Status:** Implementation-ready specification  
**Version:** 1.0  
**Date:** 2026-08-22  
**Target demo:** 2026-08-24  
**Primary runtime:** Expo Go on a physical phone  
**Primary workflow:** Side-profile barbell squat, historical sets 1–24, live set 25

## 1. Purpose

This document is the source of truth for the next Freelocity implementation. It defines one honest, runnable hero workflow from setup through personalized feedback. It also defines the limits of the demo so the application, video, and submission do not imply capabilities that are not present.

The hero story is:

1. Freelocity loads 24 explicitly labeled historical demo-seed squat sets.
2. The athlete enters the current barbell load.
3. A stationary phone is positioned at the side of the rack.
4. The user calibrates a 450 mm plate by aligning a square with its visible diameter.
5. The application tracks that calibrated plate region through a squat set and shows a yellow tracking square and trail.
6. The tracker derives rep and velocity estimates from measured plate displacement.
7. The application submits live set 25 once.
8. The API compares set 25 with load-matched personal history and returns deterministic analytics plus a constrained AI explanation.
9. The optional recovery check-in remains separate and unchanged.

## 2. Normative language

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are requirements:

- **MUST / MUST NOT:** required for the hero workflow to be called complete.
- **SHOULD:** expected unless an implementation note documents why it was deferred.
- **MAY:** optional.

## 3. Non-negotiable product truth

1. The application MUST distinguish live measurements, derived estimates, historical fixtures, manual input, and rehearsal data.
2. Historical demo data MUST be labeled `demo_seed`. It is synthetic personal context for the demonstration, not prior clinical or production data.
3. The current set MUST come from the selected live capture source. A historical row or generated waveform MUST NOT be substituted for the current set without an explicit `REHEARSAL` label.
4. A visual box MUST NOT be drawn as “tracking” unless it is driven by a current measured centroid.
5. Entered barbell weight is training context. It is not measured by the camera and MUST NOT be presented as a medical measurement.
6. The 450 mm plate diameter is a user-confirmed physical scale reference. It is not automatically known merely because a 300 px default exists.
7. Performance analytics MUST NOT be described as concussion detection, injury detection, diagnosis, treatment, or clearance to play.
8. Fit3D MUST NOT be described as a runtime dependency, training source, or live inference API.
9. “Real-time” means live local tracking/rep feedback during capture plus immediate post-set personalized API analysis. The API is not continuously inferring during the set.
10. When a measurement is unavailable, the system MUST return or display `unavailable`; it MUST NOT fabricate a normal-looking value.

## 4. Scope

### 4.1 In scope

- One side-profile squat hero workflow.
- Stationary-phone camera capture and barbell plate tracking.
- Yellow target square, short trajectory trail, and explicit tracking state.
- Plate-diameter calibration.
- Current-load entry.
- Exactly 24 read-only historical squat summaries.
- Live set 25.
- Rep segmentation and velocity estimates.
- Load-matched personal comparison.
- Confidence and limitation reporting.
- Idempotent set submission.
- Deterministic recommendation rules.
- Grounded AI wording.
- Existing optional recovery check-in, unchanged and separate.
- An explicitly labeled rehearsal mode for development only.

### 4.2 Out of scope

- Fit3D archive download or model training.
- General exercise recognition.
- Multi-person tracking.
- Form grading or joint-angle scoring.
- Continuous camera upload.
- Medical diagnosis or concussion inference from fitness data.
- A new concussion, pupil, balance, or cognitive model.
- Replacing Expo Go for the MVP without a documented go/no-go decision.

## 5. Audited current state

The following describes the code as of this specification.

| Area | Current behavior | Required change |
|---|---|---|
| Mobile states | `SETUP`, `CALIBRATE`, `RECORD`, `PROCESSING`, `FEEDBACK`, `RECOVERY` | Preserve the shape, add history readiness and real camera-tracking substates |
| Camera | `CameraView` renders a preview only | Add a proven frame acquisition adapter before claiming CV tracking |
| Mobile IMU | Samples x/y/z, feeds Y-axis × 9.81 to the local engine | Define source-specific axes; do not use stationary-phone IMU as bar motion |
| API IMU | Uses gravity-corrected Z for `barbell`/`weight_stack` and residual magnitude for `pocket` | Keep for IMU capture modes; camera hero uses position observations instead |
| Calibration | UI says reference captured but does not call `calibratePlate` | Require an observed plate diameter and persist calibration metadata with the set |
| Visual tracker | Engine can return a centroid and trajectory from RGBA frames | Connect real frames, add tracking state/confidence, and render the overlay |
| Demo | Inline `seededSamples()` auto-completes after 1.2 seconds | Keep only as opt-in `REHEARSAL`; never use in the live hero path |
| Fixture | Canonical file now contains 24 numbered, labeled historical summaries | Add runtime validation and a read-only history adapter |
| Baseline | Database history, then Sparkden text fallback | Add read-only fixture history through the same baseline service |
| Readiness | 21-day, ±15% load band, minimum 3 rows | Use exact-load-first matching and disclose widening/confidence |
| API output | Flat VBT/readiness fields and AI text | Preserve flat fields and add structured context, comparison, confidence, coaching |
| Persistence | Every successful request attempts an insert | Add `capture_id` idempotency and source/provenance metadata |
| AI failure | Can fail the whole analysis before persistence/response | Analytics MUST succeed without AI; AI failure returns deterministic coaching |
| Recovery | Three prompts and a separately labeled estimated balance action | Freeze; do not connect its score to fitness analytics |

## 6. Hero hardware and capture decision

### 6.1 Required physical arrangement

The hero uses one stationary phone:

- Portrait orientation.
- Rear camera facing the lifter from the barbell side.
- Stable tripod or fixed stand.
- Entire plate path visible from standing to squat depth.
- Approximately perpendicular to the bar path.
- Stable lighting and a visually distinct plate edge.
- No phone mounted to the barbell during this camera workflow.

This decision resolves a physical contradiction: one phone cannot be mounted on a moving barbell while simultaneously filming that barbell from a stationary side profile.

### 6.2 Capture-source contract

`capture_source` is mandatory for new submissions:

| Source | Phone arrangement | Primary measurement | Hero status |
|---|---|---|---|
| `camera_side_profile` | Stationary side camera | Plate centroid over time | Required hero source |
| `imu_barbell` | Phone securely mounted to bar/load | Configured vertical IMU axis | Supported secondary source |
| `imu_pocket` | Phone secured in pocket | Residual 3-axis magnitude | Supported secondary source, not visual bar tracking |
| `rehearsal_seeded` | No measurement claim | Generated samples | Development-only fallback |

The recording UI MUST show the active source. It MUST NOT show a “tracked barbell” label for `imu_pocket` or `rehearsal_seeded`.

## 7. Snout-to-tail hero workflow

### 7.1 State machine

```text
BOOT
  -> HISTORY_READY
  -> SETUP
  -> CAMERA_PERMISSION
  -> CAMERA_POSITIONING
  -> PLATE_CALIBRATION
  -> TRACKING_READY
  -> RECORDING
  -> REVIEW
  -> SUBMITTING
  -> FEEDBACK
  -> OPTIONAL_RECOVERY
```

Failures do not silently advance:

```text
CAMERA_PERMISSION -> PERMISSION_BLOCKED
PLATE_CALIBRATION -> REFERENCE_NEEDED
RECORDING -> TRACKING_DEGRADED | TARGET_LOST
SUBMITTING -> RETRYABLE_SUBMISSION_ERROR
```

### 7.2 Required visible checkpoints

1. **History ready**
   - “24 historical demo sets loaded”
   - “Current session: Set 25”
   - “History source: DEMO SEED”
2. **Setup**
   - Exercise fixed to Squat for the hero.
   - Load in kg.
   - Target reps.
   - Capture source fixed to Side Camera for the hero.
3. **Permission**
   - Camera permission requested with an explanation.
   - Denial produces a blocked state and an explicit rehearsal option.
4. **Positioning**
   - Side-view guidance.
   - Camera-stability indicator.
   - Plate must remain visible across expected vertical travel.
5. **Calibration**
   - User aligns a yellow square to the outside diameter of a 450 mm plate.
   - UI displays observed diameter in pixels.
   - User confirms the reference.
6. **Tracking ready**
   - A current centroid is measured.
   - Tracking confidence meets the start threshold.
   - The start button remains disabled until ready or the user explicitly enters rehearsal mode.
7. **Recording**
   - Yellow square follows the plate.
   - Short fading path shows up/down travel.
   - Rep count, current velocity estimate, source, confidence, and tracking state are visible.
8. **Review**
   - Actual detected reps.
   - Duration.
   - Capture quality.
   - Retake or submit.
9. **Submitting**
   - One `capture_id`.
   - Retry reuses the same ID.
10. **Feedback**
   - “Set 25”
   - 24 historical sets loaded.
   - Number of matched sets.
   - Current metrics and personal deltas.
   - Confidence and limitations.
   - One next action.
11. **Optional recovery**
   - Separate entry point and disclaimer.
   - No fitness metric enters recovery scoring.

## 8. Camera frame acquisition feasibility gate

### 8.1 Current limitation

The installed `expo-camera` `CameraView` provides the preview used by the app but the current code has no per-frame RGBA callback. The existing `processFrame(rgba, width, height, dt)` function therefore has no live input.

### 8.2 Required spike

Before building the full overlay, implement and test one Expo Go-compatible acquisition adapter on the intended phone:

1. Hold a typed ref to `CameraView` and wait for `onCameraReady`.
2. Call `takePictureAsync` with `base64: true`, low `quality`, `skipProcessing: false`, and shutter sound disabled where the platform supports it.
3. Convert base64 to bytes with the pure-JavaScript `base64-js` package.
4. Decode JPEG bytes to RGBA with the pure-JavaScript `jpeg-js` package.
5. Downsample RGBA locally before tracking with one uniform scale:
   - `s = min(192 / Wc, 144 / Hc, 1)`
   - `Wt = round(Wc * s)`
   - `Ht = round(Hc * s)`
   - no stretching to a fixed aspect ratio.
6. Add `base64-js` and `jpeg-js` as mobile dependencies; neither requires a custom native module, so they remain compatible with Expo Go.
7. Use the returned captured-picture width/height and decoded width/height; never assume they equal the preview dimensions.
8. No captured image is uploaded or retained.
9. Zero or release base64, JPEG, and RGBA references after extracting the tracker observation.
10. Capture must not queue multiple outstanding frames. A new capture starts only after the prior decode/track operation finishes.

The spike MUST verify that `skipProcessing: false` produces consistently oriented pixels on the actual iOS/Android demo device. If decoded orientation differs from the returned dimensions or preview, the adapter must normalize EXIF orientation before tracking; otherwise the spike fails.

### 8.3 Go/no-go thresholds

The camera hero may be called live CV only if a physical-phone test achieves:

- Sustained processed rate: at least 2 frames per second for 30 seconds.
- Median observation latency: at most 600 ms.
- 95th percentile observation latency: at most 1,000 ms.
- No unhandled camera error.
- No continuously growing frame queue.
- At least 80% of frames tracked during one controlled five-rep set.
- Target reacquired within 1.5 seconds after one brief occlusion.

Two frames per second is a minimum demo threshold, not an accuracy claim. The video and UI SHOULD disclose “low-rate visual tracking” if the processed rate remains below 10 FPS.

### 8.4 If the spike fails

The implementation MUST choose one and document it:

1. Keep Expo Go, hide the live-CV claim and ship the IMU hero without a tracking box; or
2. Approve a development build/native frame processor and update the runtime requirement.

Animating a box from time, rep count, accelerometer values, or a fixed center position is not an acceptable substitute for live CV.

## 9. Plate calibration and visual tracking

### 9.1 Calibration

The MVP uses user-initialized tracking, not automatic plate recognition:

1. Capture one calibration still through the same JPEG/RGBA adapter used for tracking.
2. Display that exact still with known oriented capture dimensions.
3. Display a resizable/movable yellow square.
4. User aligns the square with the plate’s outer diameter.
5. Record:
   - `reference_diameter_m = 0.45`
   - `observed_diameter_px`
   - initial centroid
   - frame dimensions
   - capture timestamp
6. Compute `meters_per_pixel = 0.45 / observed_diameter_px`.
7. Reject diameters below 20 px or above 80% of the smaller frame dimension.

The current `DEFAULT_PLATE_PX = 300` MAY initialize the UI but MUST NOT be reported as measured calibration.

### 9.2 Coordinate spaces

The implementation uses three explicit coordinate spaces:

1. **Capture space:** oriented JPEG/RGBA width `Wc`, height `Hc`.
2. **Processing space:** downsampled width `Wt`, height `Ht`.
3. **Preview space:** rendered `CameraView` width `Wp`, height `Hp`.

Calibration MUST be stored in capture space first. It is then converted to processing space:

```text
x_t = x_c * processing_scale
y_t = y_c * processing_scale
diameter_t = diameter_c * processing_scale
meters_per_processing_pixel = 0.45 / diameter_t
```

`processing_scale` is uniform and MUST satisfy `Wt / Wc ≈ Ht / Hc` within rounding tolerance. Non-uniformly resized frames are rejected.

The calibration still is displayed with the same aspect-fill rule as the live preview. For an oriented capture:

```text
preview_scale = max(Wp / Wc, Hp / Hc)
crop_x = (Wc * preview_scale - Wp) / 2
crop_y = (Hc * preview_scale - Hp) / 2

x_p = x_c * preview_scale - crop_x
y_p = y_c * preview_scale - crop_y

x_c = (x_p + crop_x) / preview_scale
y_c = (y_p + crop_y) / preview_scale
```

Square diameter uses the same scale. The implementation MUST:

- apply preview-to-capture before storing user calibration;
- apply capture-to-processing before motion measurement;
- apply processing-to-capture-to-preview before drawing the live box;
- account for device rotation before these transforms;
- test all transforms with known points at the center and four frame edges.

Velocity MUST use `meters_per_processing_pixel`; preview pixels are never used directly in movement calculations.

### 9.3 Tracker algorithm

For a reliable best-case demo, tracking is constrained around the calibrated plate:

1. Convert each downsampled frame to grayscale.
2. Retain the calibrated plate patch as a short-lived local template.
3. Search within a constrained region around the previous centroid:
   - wider vertically than horizontally;
   - bounded by the frame;
   - expanded while `SEARCHING`.
4. Score candidates with normalized patch correlation plus edge/motion agreement.
5. Select a centroid only when its score passes the tracking threshold.
6. Smooth accepted centroids with a Kalman or exponential filter.
7. Reject implausible jumps based on elapsed time and maximum plate speed.
8. Refresh the template conservatively only during high-confidence tracking.

The existing largest-moving-component detector MAY support candidate generation, but it MUST NOT be the only selector because the lifter can be a larger moving component than the plate.

### 9.4 Visual tracking state

```ts
type VisualTrackingStatus =
  | "TRACKING"
  | "SEARCHING"
  | "REFERENCE_NEEDED"
  | "UNAVAILABLE";

type TrackingConfidence = "HIGH" | "MEDIUM" | "LOW";

type VisualTrackingState = {
  centroid: { x: number; y: number } | null;
  targetSizePx: number | null;
  trail: Array<{ x: number; y: number; ageMs: number }>;
  status: VisualTrackingStatus;
  confidence: TrackingConfidence;
  confidenceScore: number;
  processedFps: number;
  lastMeasuredAt: number | null;
};
```

### 9.5 Overlay rules

- `TRACKING`: solid yellow square at the measured/smoothed centroid.
- `SEARCHING`: last box may remain dashed and dimmed for at most 500 ms, then disappears.
- `REFERENCE_NEEDED`: calibration guide is shown, not a tracking claim.
- `UNAVAILABLE`: no target square.
- Trail contains no more than the latest 1.5 seconds of measured centroids.
- All points are mapped from processed-frame coordinates to preview coordinates with aspect-fill cropping accounted for.
- Box and trail are clipped to the camera viewport.
- The overlay never covers the source/confidence label.

## 10. Camera-derived measurements

### 10.1 Position observations

```ts
type CameraPositionObservation = {
  timestampMs: number;
  xPx: number;
  yPx: number;
  trackingScore: number;
};
```

Invalid or missing observations are omitted; they are not replaced with interpolated “measurements.” Short gaps MAY be interpolated for smoothing only and MUST lower confidence.

### 10.2 Displacement and velocity

For accepted observations:

```text
vertical_position_m = -(y_px - calibrated_y_px) * meters_per_pixel
velocity_m_s = delta(vertical_position_m) / delta(time_s)
```

Requirements:

- Timestamps, not assumed frame rate, define `dt`.
- A median filter or outlier rejection runs before differentiation.
- A low-pass/Kalman filter runs before velocity metrics are emitted.
- Gaps over 1 second break a segment.
- Velocity is unavailable until at least two valid observations exist.

### 10.3 Rep segmentation

A rep is one complete down/up cycle:

1. Start after displacement passes a configurable descent threshold.
2. Bottom is a direction change following minimum descent.
3. Complete after the plate returns within the top tolerance.
4. Require minimum duration and minimum range of motion.
5. Do not count a rep from one isolated velocity sign change.

Initial hero thresholds:

- Minimum vertical excursion: 0.15 m.
- Minimum rep duration: 0.8 s.
- Maximum rep duration: 8 s.
- Top return tolerance: 0.08 m from the local start.
- Minimum valid tracking coverage per rep: 70%.

These thresholds are engineering defaults and MUST be tuned on physical-phone recordings before the demo.

### 10.4 Per-set features

- actual reps
- per-rep duration
- per-rep peak concentric velocity
- per-rep mean concentric velocity
- first-rep peak velocity
- set mean velocity
- set peak velocity
- velocity loss from first valid rep to last valid rep
- vertical range of motion
- duration
- processed frame count
- tracked frame ratio
- processed FPS
- calibration diameter in pixels
- measurement confidence

## 11. IMU capture contract

IMU remains supported but is not mixed with the stationary-camera hero measurement.

### 11.1 Units

- Mobile raw samples are x/y/z in G.
- API converts G to m/s² exactly once.
- Local tracker receives m/s².
- Timestamps are milliseconds since epoch or a documented monotonic base.

### 11.2 Axis configuration

`imu_barbell` MUST record the vertical device axis selected during a short placement calibration. It MUST NOT hard-code mobile Y while the server hard-codes Z.

The calibration records:

```ts
type ImuAxisCalibration = {
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  gravityBaselineG: { x: number; y: number; z: number };
};
```

The API uses the supplied validated axis/sign. Legacy requests without calibration retain current Z behavior and receive degraded confidence.

## 12. Historical fixture

### 12.1 Canonical source

`/home/runner/workspace/previous_sets.json` is the canonical demo-history fixture.

It MUST:

- be valid JSON;
- contain exactly 24 array entries;
- contain unique IDs and set numbers 1 through 24;
- be sorted by `setNumber`;
- contain only squat rows;
- use `source: "demo_seed"`;
- contain at least three 60 kg rows;
- use only finite, physically plausible numeric values;
- represent unavailable displacement as `null`;
- never be overwritten by runtime persistence.

### 12.2 Canonical row

```ts
type DemoHistoricalSet = {
  id: `demo-squat-${string}`;
  setNumber: number;
  exercise: "squat";
  daysBeforeDemo: number;
  loadKg: number;
  targetReps: number;
  actualReps: number;
  legacyFirstRepVelocityMs: number;
  firstRepPeakMs: null;
  meanVelocityMs: number;
  peakVelocityMs: null;
  velocityLossPct: number;
  meanRepTimeSec: number;
  durationSec: number;
  displacementM: number | null;
  phonePlacement: "barbell";
  captureSource: "historical_summary";
  source: "demo_seed";
  provenance: "legacy_current_set" | "authored_demo_seed";
  expectedAnnotation: {
    personalBaseline: {
      sampleCount: number;
      firstRepVelocity: number;
      velocityLossPct: number;
      meanRepTime: number;
    };
    deviations: Array<{
      metric: string;
      changePct: number;
      confidence: number;
    }>;
    recommendedAction: string;
  };
};
```

`expectedAnnotation` preserves the legacy scenario context for regression examples. It MUST NOT be used as the computed baseline or accepted as ground-truth output.

### 12.3 Derivation disclosure

The 23 legacy rows provided first-rep velocity, velocity loss, reps, and mean rep time, but did not provide mean velocity, duration, or displacement.

The normalized fixture uses:

```text
estimated_last_rep_velocity = legacy_first_rep_velocity * (1 - velocity_loss_pct / 100)
mean_velocity = mean(legacy_first_rep_velocity, estimated_last_rep_velocity)
duration = actual_reps * mean_rep_time
displacement = null
```

These are fixture normalization estimates, not retroactively measured values. The 24th row is explicitly marked `authored_demo_seed`.

Metric provenance is normative:

| Fixture field | Provenance | May compare to live camera? |
|---|---|---|
| `legacyFirstRepVelocityMs` | Legacy first-rep velocity summary with unknown peak/mean semantics | Display as historical context only; no automatic delta or action |
| `firstRepPeakMs` | Unavailable in the legacy fixture | Never |
| `velocityLossPct` | Legacy set summary | Illustrative cross-source comparison only |
| `meanRepTimeSec` | Legacy set summary | Yes, with synthetic-history disclosure |
| `meanVelocityMs` | Derived from the unknown legacy first-rep velocity plus loss | No direct live delta; fixture-only illustrative trend |
| `peakVelocityMs` | Unavailable in the legacy fixture | Never |
| `durationSec` | Derived reps × mean rep time | No direct live delta |
| `displacementM` | Unavailable | Never |

The fixture does not establish whether `firstRepVelocity` meant peak or mean velocity, or whether historical velocities came from the same camera pipeline, calibration, or sensor placement as the live hero set. The normalized fixture therefore preserves it under `legacyFirstRepVelocityMs` and sets `firstRepPeakMs` and `peakVelocityMs` to `null`.

### 12.4 Relative dates

At request time:

```text
performed_at = demo_reference_time - daysBeforeDemo
```

`demo_reference_time` is the start of the current demo run. This keeps the fixture deterministic and within the 21-day demonstration window without rewriting it.

The loader MUST NOT call `new Date()` independently for each row. One request/session reference time is used for all rows.

## 13. Baseline service

### 13.1 Source composition

All comparison logic receives normalized historical rows from one service:

```ts
type HistorySource = "demo_seed" | "database" | "sparkden";

type HistoricalPerformance = {
  id: string;
  performedAt: string;
  exerciseName: string;
  loadKg: number;
  actualReps: number;
  meanVelocityMs: number;
  peakVelocityMs: number | null;
  firstRepPeakMs: number | null;
  legacyFirstRepVelocityMs: number | null;
  velocityLossPct: number | null;
  meanRepTimeSec: number | null;
  source: HistorySource;
  captureSource: string;
};
```

Hero mode uses the 24 `demo_seed` rows for numbering and personal comparison. Database and Sparkden records MAY be displayed separately but MUST NOT silently change “set 25.”

History compatibility is explicit:

```ts
type ComparisonMode =
  | "SAME_SOURCE"
  | "CROSS_SOURCE_DEMO"
  | "UNAVAILABLE";
```

- `SAME_SOURCE` requires the same exercise, capture source family, and compatible calibration method.
- `CROSS_SOURCE_DEMO` is permitted only for the labeled fixture and returns illustrative velocity-loss and rep-time comparisons. Its legacy first-rep velocity is context-only.
- `UNAVAILABLE` returns null deltas.
- Production athlete history MUST default to `UNAVAILABLE` rather than silently comparing incompatible capture sources.

Motor readiness is available only for `SAME_SOURCE` with at least three compatible measured first-rep peaks. For `CROSS_SOURCE_DEMO`:

- `cns_readiness_score` is null;
- `motor_readiness_level` is `"Insufficient data"`;
- `baseline_velocity_ms` is null;
- `velocity_trend` is null;
- readiness-derived AI evidence is omitted;
- the fixture’s derived mean velocity MUST NOT be used as a readiness fallback.

### 13.2 Matching

For exercise `squat`, matching proceeds in tiers:

1. Exact nominal load: ±0.5 kg.
2. If fewer than 3 rows, narrow band: ±5%.
3. If still fewer than 3, current compatibility band: ±15%.
4. If still fewer than 3, insufficient baseline.

The response returns the selected tier and range. Confidence decreases when the band widens.

At the default 60 kg hero load, the first three fixture rows provide an exact-load baseline.

### 13.3 Baseline features

For the selected matched rows:

- sample count
- mean and median legacy first-rep velocity, labeled as unknown summary semantics and excluded from decisions
- fixture-only mean-velocity trend, labeled derived
- mean velocity loss
- mean rep duration
- recent illustrative trend from chronological fixture mean velocity
- source breakdown
- load-match tier
- comparison mode and compatibility reasons

The current set is never included in its own baseline.

## 14. Comparison and confidence

### 14.1 Comparison deltas

```text
signed_delta = current - baseline
percent_delta = 100 * signed_delta / baseline
```

Return deltas for:

- velocity loss
- mean rep duration

First-rep-peak and mean-velocity deltas are returned only for `SAME_SOURCE`. Both are null for the current `CROSS_SOURCE_DEMO` fixture because the legacy first-rep metric has unknown peak/mean semantics and historical `meanVelocityMs` was derived rather than measured.

Do not compute a percent delta when the baseline is zero, unavailable, derived with incompatible semantics, or from an incompatible source.

### 14.2 Confidence components

```ts
type ConfidenceBreakdown = {
  overall: number;             // 0..1
  level: "HIGH" | "MEDIUM" | "LOW";
  measurement: number;         // live capture quality
  calibration: number;         // reference validity
  tracking: number;            // coverage, score, fps, gaps
  baseline: number;            // match count/source/load tier
  reasons: string[];
};
```

For camera capture:

- tracked-frame ratio
- median tracking score
- processed FPS
- longest gap
- calibration diameter validity
- rep tracking coverage

For the demo-seed baseline:

- baseline measurement compatibility is always `LOW`;
- overall coaching confidence MUST be capped at `MEDIUM` because the history is synthetic.

Suggested level thresholds:

- High: `>= 0.80`
- Medium: `>= 0.55`
- Low: `< 0.55`

If measurement confidence is below 0.45, recommendation MUST be `repeat_or_verify_set`.

## 15. Deterministic recommendation

The deterministic layer runs before AI.

Priority rules:

1. **Insufficient measurement**
   - Trigger: low measurement confidence, fewer than 2 valid reps, or target lost for a material part of the set.
   - Action: `repeat_or_verify_set`.
2. **High within-set fatigue**
   - Trigger: velocity loss ≥20% with medium-or-better measurement confidence.
   - Action: `rest_longer_or_reduce_load`.
3. **Meaningful negative personal deviation**
   - Trigger: `SAME_SOURCE` first-rep peak velocity ≤−10% vs a measured matched baseline.
   - Action: `rest_longer_or_reduce_load`.
4. **Stable**
   - Trigger: no higher-priority rule matched and current-set velocity loss <20%.
   - Action: `maintain_load`.
5. **Strong and controlled**
   - Trigger: `SAME_SOURCE` first-rep peak velocity >5% above a measured matched baseline and velocity loss ≤10%.
   - Action: `consider_small_load_increase`.

For `CROSS_SOURCE_DEMO`, historical first-rep and derived mean-velocity values MUST NOT select or change an action. The action may use current-set measurement quality and current within-set velocity loss. Historical velocity-loss and rep-time differences may be shown as illustrative context only.

The API returns:

- action code
- reasons with actual values
- rule version
- uncertainty

The AI may explain the action but MUST NOT change it.

## 16. API contract

### 16.1 Endpoint

Continue using:

```http
POST /api/analyze-set
```

Existing fields remain accepted:

- `exercise_name`
- `weight_kg`
- `target_reps`
- `total_sets`
- `phone_placement`
- `samples`

The endpoint accepts an explicit union, not one shape with contradictory required fields:

```ts
type AnalyzeSetRequestLegacy = SetAnalysisRequest & {
  contract_version?: undefined;
};

type AnalyzeSetRequestVNext = Omit<SetAnalysisRequest, "samples"> & {
  contract_version: "2026-08-22";
  capture_id: string;
  demo_run_token: string;
  set_number: 25;
  capture_source:
    | "camera_side_profile"
    | "imu_barbell"
    | "imu_pocket"
    | "rehearsal_seeded";
  history_mode: "demo_seed_v1" | "athlete_history";
  samples: AccelerationSample[];
  camera_tracking?: {
    coordinate_space: "processing_rgba";
    reference_diameter_m: 0.45;
    observed_diameter_px: number;
    processing_width_px: number;
    processing_height_px: number;
    capture_width_px: number;
    capture_height_px: number;
    processing_scale_from_capture: number;
    calibration_centroid: { xPx: number; yPx: number };
    processed_fps: number;
    positions: CameraPositionObservation[];
  };
  imu_calibration?: ImuAxisCalibration;
};

type AnalyzeSetRequest =
  | AnalyzeSetRequestLegacy
  | AnalyzeSetRequestVNext;
```

### 16.2 Versioned validation

Legacy branch:

- No `contract_version`.
- Current request validation and current flat response fields remain supported.
- Source is inferred from `phone_placement`.
- Confidence is degraded because capture ID, axis calibration, and provenance are unavailable.
- Legacy requests do not receive set-25 idempotency guarantees.

VNext branch:

- `camera_side_profile` requires `camera_tracking.positions`; acceleration `samples` may be empty and are ignored for bar-motion analysis.
- All submitted positions, their calibration centroid, and `observed_diameter_px` are in `processing_rgba` coordinates.
- The API verifies that positions and diameter fit the processing dimensions.
- The API verifies that the declared processing scale matches both width and height ratios within rounding tolerance; non-uniform scaling is rejected.
- The API derives meters per pixel only from the submitted processing-space diameter.
- `imu_barbell` and `imu_pocket` require acceleration `samples`.
- `rehearsal_seeded` requires an explicit development flag and never returns live measurement labeling.
- `set_number` must be 25 in `demo_seed_v1`.
- `capture_id` must be a UUID.
- `demo_run_token` must be a server-issued, signed, unexpired token.

The OpenAPI document expresses this with `oneOf`, and the route validates it with a discriminated union on `contract_version`. Generated clients expose separate legacy and VNext request types.

The server can structurally validate the declared coordinate contract but cannot prove from numeric bounds alone that the client transformed a diameter correctly. Semantic transform correctness is established by deterministic client fixtures, round-trip transform tests, and the physical calibration gate.

### 16.3 Additive response fields

Existing flat response fields remain for compatibility. Add:

```ts
type AnalyzeSetResultVNext = SetAnalysisResult & {
  set_context: {
    current_set_number: number;
    prior_set_count: number;
    history_mode: "demo_seed_v1" | "athlete_history";
    history_sources: HistorySource[];
    comparison_mode: ComparisonMode;
    capture_id: string;
    persisted: boolean;
    duplicate: boolean;
  };
  measurement: {
    source: AnalyzeSetRequestVNext["capture_source"];
    quality: "GOOD" | "DEGRADED" | "REHEARSAL";
    confidence: ConfidenceBreakdown;
    limitations: string[];
  };
  baseline: {
    available: boolean;
    matched_count: number;
    load_match_tier: "EXACT" | "NARROW" | "WIDE" | "NONE";
    load_min_kg: number | null;
    load_max_kg: number | null;
    first_rep_peak_ms: number | null;
    legacy_first_rep_velocity_ms: number | null;
    mean_velocity_ms: number | null;
    velocity_loss_pct: number | null;
    mean_rep_time_s: number | null;
    trend: string;
    synthetic_history: boolean;
    compatible_metrics: string[];
    incompatible_metrics: string[];
    compatibility_reasons: string[];
  };
  comparison: {
    first_rep_velocity_delta_pct: number | null;
    mean_velocity_delta_pct: number | null;
    velocity_loss_delta_pct: number | null;
    mean_rep_time_delta_pct: number | null;
  };
  coaching: {
    action: string;
    reasons: string[];
    uncertainty: string;
    rule_version: string;
    ai_explanation: string | null;
    ai_available: boolean;
  };
};
```

### 16.4 Error behavior

- Invalid body: HTTP 400 with validation issues.
- Invalid or expired demo-run token: HTTP 401.
- Unsupported capture source: HTTP 400.
- Insufficient camera observations: HTTP 422 with measurable reason.
- Duplicate `capture_id`: HTTP 200 with the original result and `duplicate: true`.
- AI unavailable: HTTP 200 with deterministic analytics and `ai_available: false`.
- Persistence unavailable: HTTP 200 only if analysis succeeded, with `persisted: false` and a visible warning.
- Baseline unavailable: HTTP 200 with `baseline.available: false`; no fabricated comparison.

## 17. Persistence and idempotency

### 17.1 Owner scope

The hackathon app is single-athlete but MUST NOT use a globally retrievable client ID:

1. Mobile requests an anonymous demo run from `POST /api/demo-runs`.
2. Server returns an opaque `demo_run_token` signed with the existing server session secret.
3. The verified token yields a random `owner_scope` and expiry; it contains no personal information.
4. The mobile stores the token for the active demo run only.
5. Every VNext analysis is scoped by `(owner_scope, capture_id)`.
6. Duplicate lookup never returns a row from another owner scope.

A future authenticated product replaces `owner_scope` with the authenticated user/athlete ID.

### 17.2 Required persistence metadata

The live set record requires:

- owner scope
- `capture_id`
- composite unique constraint on `(owner_scope, capture_id)`
- `set_number`
- `capture_source`
- `history_mode`
- `source` (`live`, `rehearsal`)
- measurement quality/confidence
- phone placement
- calibration metadata
- existing VBT metrics
- created timestamp
- request hash
- processing status and lease timestamp
- canonical response snapshot as JSON

The canonical response snapshot includes deterministic analytics, baseline version, coaching action, and the AI explanation that was originally returned. It prevents retries from silently changing because history or model output changed.

### 17.3 Atomic retry semantics

1. Mobile generates `capture_id` when recording starts.
2. The same ID survives review, submission retries, and feedback reload.
3. API hashes the normalized request.
4. API atomically reserves `(owner_scope, capture_id)` with `INSERT ... ON CONFLICT DO NOTHING`.
5. The winner records status `PROCESSING` with a short lease, computes once, stores the canonical response snapshot, and marks `COMPLETE`.
6. A duplicate with a different request hash returns HTTP 409.
7. A duplicate while the winner is processing returns HTTP 202 plus `Retry-After`.
8. A duplicate after completion returns the stored snapshot with `duplicate: true`.
9. An expired failed-processing lease may be reclaimed safely.
10. A new demo run may still call its live record “Set 25” relative to the fixed 24-row fixture, but it has a new capture ID and owner-scoped run token.

Historical fixture rows are never inserted merely to calculate the demo baseline. This prevents reload duplication.

## 18. AI coaching contract

### 18.1 Inputs

The model receives only:

- exercise and entered load
- target and actual reps
- capture source and quality
- deterministic current metrics
- baseline metrics and matched count
- comparison deltas
- confidence reasons
- deterministic action and reasons
- explicit limitations

It does not receive raw camera frames.

Only compatible comparison metrics enter the recommendation prompt. In `CROSS_SOURCE_DEMO`, `legacyFirstRepVelocityMs`, derived `meanVelocityMs`, and derived trend MUST be omitted from recommendation evidence; they may appear in a separately labeled historical-context display.

`CROSS_SOURCE_DEMO` also omits readiness score, readiness level, baseline velocity, and readiness trend from the AI prompt. The model may discuss only current-set quality/fatigue and explicitly illustrative velocity-loss or rep-time context.

### 18.2 Output constraints

The explanation:

- is 2–4 sentences;
- cites at least two supplied values when available;
- states when history is a demo seed;
- gives exactly one next action;
- states uncertainty when confidence is not high;
- does not diagnose injury or concussion;
- does not claim Fit3D or model training;
- does not invent a metric.

### 18.3 Deterministic fallback

AI is enrichment, not a dependency. If it fails:

- analytics still return;
- `ai_available` is false;
- `ai_explanation` is null;
- the UI renders the deterministic action and reasons.

## 19. Mobile feedback contract

The feedback screen MUST show:

1. Set 25.
2. Source badge: `LIVE CAMERA`, `LIVE IMU`, or `REHEARSAL`.
3. “Compared with N matched sets from 24 historical demo sets.”
4. Current reps, mean velocity, first-rep peak, velocity loss, mean rep duration, and duration.
5. Personal deltas.
6. Tracking/measurement confidence and reasons.
7. Motor readiness estimate only when `comparison_mode` is `SAME_SOURCE` and the response contains an adequate measured baseline.
8. One deterministic next action.
9. AI explanation, if available.
10. “Performance guidance only; not medical or injury assessment.”

For `CROSS_SOURCE_DEMO`, the readiness card says **Same-source readiness unavailable** and MUST NOT show a score. Historical velocity-loss and rep-time differences are labeled **Illustrative demo-history context**.

When readiness is available, the UI SHOULD say **Motor readiness estimate**, not imply direct measurement of the central nervous system.

## 20. Recovery non-regression boundary

This update does not redesign or validate the recovery check-in.

The following current behavior is frozen:

- Separate `RECOVERY` state entered from feedback.
- Explicit consent before prompts.
- Three displayed prompts:
  - orientation
  - concentration
  - memory
- Correct/incorrect answer recording.
- Existing cognitive penalty formula on a 10-answer scale.
- Existing risk thresholds:
  - Low ≤25
  - Moderate ≤55
  - High >55
- Existing pupil and balance helper APIs.
- Existing disclaimer and escalation wording.
- Balance excluded from the current composite total.

Known limitations MUST be documented:

- The visible flow has three prompts while the helper score supports ten.
- The current balance action records one hard-coded estimate and does not perform a measured 10-second sensor capture.
- Pupil capture and report sharing are not wired into the current hero UI.
- The report string’s “Authenticated Session” wording does not establish strong authentication.

For this update:

- recovery is not part of the required hero success path;
- it MUST NOT consume fitness measurements;
- it MUST NOT alter fitness recommendations;
- it MUST NOT be demonstrated as a validated concussion assessment;
- regression tests freeze current behavior before later safety work.

## 21. Privacy and data handling

- Raw camera frames remain on device and are released after observation extraction.
- Raw frames are not persisted, uploaded, logged, or included in AI prompts.
- Position observations and derived metrics MAY be submitted.
- Accelerometer samples MAY be submitted for IMU modes.
- Demo history contains no personal identifiers.
- Logs MUST omit raw frame buffers and secrets.
- Failure logs MAY include capture ID, source, counts, timing, and non-sensitive error codes.

## 22. Test and acceptance matrix

### 22.1 Fixture

- Parses successfully.
- Exactly 24 rows.
- IDs unique.
- Set numbers exactly 1–24.
- Chronological relative offsets.
- All exercise values are squat.
- All source values are `demo_seed`.
- At least three exact 60 kg rows.
- `legacyFirstRepVelocityMs` preserves the legacy value.
- `firstRepPeakMs` and `peakVelocityMs` are null for every legacy/seed row.
- Displacement is null when unavailable.
- Runtime loader does not mutate the file.

### 22.2 Camera and calibration

- Permission grant and denial.
- Base64/JPEG decoding produces RGBA with the reported orientation and dimensions.
- Capture buffers are released and no work queue grows over 30 seconds.
- Invalid calibration diameter rejected.
- 450 mm reference produces expected meters-per-pixel.
- Preview → capture → processing → preview round-trip stays within 1 px at the center and frame edges.
- Non-uniform width/height scale declarations are rejected.
- Client transform fixtures verify that a known capture-space diameter becomes the expected processing-space diameter.
- Server checks coordinate bounds, declared dimensions, and uniform-scale consistency without claiming semantic proof of the client transform.
- Coordinate mapping respects preview aspect-fill.
- No square before a measured centroid.
- Target loss hides the square after timeout.
- Trail uses only measured centroids.
- Physical-phone frame gate passes before CV claim.

### 22.3 Tracker

- Synthetic image-sequence unit fixtures test centroid acquisition, vertical tracking, loss, and reacquisition.
- Controlled squat video/images test at least one down/up cycle.
- Rep count target: 5/5 on the best-case reference set.
- Rep count is not incremented from a single jitter reversal.
- Velocity uses measured timestamps.
- Tracking gaps lower confidence.

### 22.4 Baseline

- Default 60 kg set matches exactly three rows before widening.
- Exact tier preferred to ±5% and ±15%.
- Current set excluded.
- Relative dates fall inside the reference window.
- Insufficient history returns null comparisons.
- Cross-source demo mode returns null mean-velocity delta.
- Cross-source demo mode returns null first-rep-peak delta.
- Cross-source demo mode returns null readiness score, baseline velocity, and readiness trend.
- Same-source mode permits measured mean-velocity delta.
- Same-source mode permits readiness only with at least three measured first-rep peaks.
- Compatibility reasons disclose synthetic/derived history.
- Changing only a legacy first-rep fixture value cannot change the deterministic action.
- Changing only a legacy or derived fixture velocity cannot create or change a readiness score.
- Normal and slower set produce different deterministic actions.

### 22.5 API

- Legacy IMU request still validates.
- Legacy request does not receive VNext idempotency claims.
- Camera request validates conditionally.
- Existing flat response fields remain.
- Structured context fields are present.
- Invalid demo-run token cannot read an analysis.
- Same capture ID under a different owner scope cannot read another run.
- Concurrent duplicate capture creates one reservation and one canonical result.
- Duplicate with a different request hash returns 409.
- Completed duplicate returns the stored response snapshot.
- AI failure returns analytics.
- Persistence failure is visible.
- Rehearsal response cannot be labeled live.

### 22.6 Mobile happy path

- Clean launch.
- History shows 24.
- Setup shows set 25.
- Permission works.
- Calibration is real.
- Start requires tracking readiness.
- Yellow square follows one full squat cycle.
- Five reps complete and review appears.
- Submit reaches API.
- Feedback identifies set 25 and matched history.
- Demo-seed feedback labels historical deltas illustrative and shows same-source readiness unavailable.
- Retry does not duplicate.
- Optional recovery remains separate.

### 22.7 Recovery regression

- Consent gate unchanged.
- Exact three prompts unchanged.
- Answer/domain counts unchanged.
- Existing score formulas and thresholds unchanged.
- Fitness result does not change recovery score.
- Recovery result does not change coaching action.

## 23. Demo script and evidence

The recorded submission SHOULD show, without cuts that conceal state changes:

1. App launch.
2. “24 historical demo sets loaded.”
3. “Set 25.”
4. Load entry.
5. Side camera placement.
6. Manual plate-diameter alignment.
7. Tracking-ready state.
8. Yellow square and trail following at least one complete squat.
9. Live rep increments.
10. Stop/review.
11. API processing.
12. Set-25 feedback with matched baseline, deltas, confidence, and one action.

The narration/submission MUST disclose:

- the 24 historical rows are a synthetic demo seed;
- the current set is live measured input;
- camera tracking is low-rate if the frame gate only meets the minimum;
- velocity and readiness are estimates;
- the recovery check is separate and non-diagnostic;
- Fit3D is not used.

## 24. Implementation order

### P0 — Feasibility and truth

1. Validate Expo Go capture, base64/JPEG decode, orientation, and throughput on the physical demo phone.
2. Validate the preview/capture/processing coordinate transforms.
3. Resolve the stationary-camera capture source.
4. Validate the normalized 24-row fixture.
5. Add owner-scoped capture ID and atomic idempotency.

### P1 — End-to-end hero

1. Real calibration UI.
2. Constrained plate tracker.
3. Yellow overlay and trail.
4. Camera-derived position/velocity/rep features.
5. Extended API request/response.
6. Unified fixture/database history service.
7. Set-25 feedback.

### P2 — Reliability

1. Confidence scoring.
2. Target-loss behavior.
3. Deterministic recommendation.
4. AI-failure fallback.
5. Physical-phone clean-run validation.

### P3 — Submission

1. Recovery regression checks.
2. Limitation copy.
3. Demo script.
4. Screen recording and final evidence.

## 25. File ownership map

| Concern | Primary files |
|---|---|
| Mobile workflow/overlay | `artifacts/freelocity-mobile/app/index.tsx` |
| Tracker state/hook | `artifacts/freelocity-mobile/src/hooks/useVbtTracker.ts` |
| CV and rep engine | `artifacts/freelocity-mobile/src/lib/vbtTracker.ts` |
| Recovery UI/hook | `artifacts/freelocity-mobile/src/hooks/useConcussionTracker.ts` |
| Recovery algorithms | `artifacts/freelocity-mobile/src/lib/concussionTracker.ts` |
| Analysis route | `artifacts/api-server/src/routes/coaching.ts` |
| Demo-run token and idempotency | API route/service plus database schema |
| Baseline/readiness | `artifacts/api-server/src/cns-readiness.ts` |
| Exercise VBT profile | `artifacts/api-server/src/vbt-profiles.ts` |
| Sparkden optional history | `artifacts/api-server/src/sparkden-client.ts` |
| Persistence schema | `lib/db/src/schema/sets.ts` |
| OpenAPI contract | `lib/api-spec/openapi.yaml` |
| Historical fixture | `previous_sets.json` |

## 26. Role of the AIFit paper

The AIFit paper supports only the general pipeline:

```text
motion representation
-> repetition segmentation
-> movement signature
-> reference comparison
-> interpretable feedback
```

It does not validate:

- phone accelerometer or low-rate Expo camera accuracy;
- this project’s personal-baseline algorithm;
- medical or concussion inference;
- Fit3D use;
- the claim that 24 synthetic sets train a general model.

Freelocity uses the paper as architectural inspiration, not as evidence that the implementation has equivalent accuracy or validation.

## 27. Definition of done

The next implementation is complete only when:

- the canonical fixture has exactly 24 valid rows;
- the app visibly starts live set 25;
- the live source is truthful and labeled;
- the physical-phone frame gate passes or the CV claim is removed;
- frame orientation and both-way coordinate transforms are verified;
- calibration uses an observed plate diameter;
- the yellow square follows measured plate motion;
- current metrics come from that live source;
- the API returns structured baseline, comparison, confidence, and coaching;
- retries are owner-scoped, atomic, and return the stored canonical response;
- AI failure does not erase analytics;
- feedback cites actual values and one next action;
- recovery remains separate and unchanged;
- the entire hero path is completed on the intended phone without code edits or hidden data substitution.
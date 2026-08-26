# Freelocity Motion Tracker

Freelocity is a measurement-first Expo/React Native application for velocity-based strength-training analysis using local computer vision or mobile IMU sensing, load-matched history, and bounded AI coaching.

> **Active strategy: Strategy A — Performance Triage & Demo MVP Stabilization**
>
> Until the exit criteria below pass, optimize for **zero-crash reliability, smooth UI, measurement correctness, deterministic behavior, and demo readiness before adding features**.

## Core Engineering Invariant

**Never fabricate a physical measurement.**

If camera/sensor data is insufficient or untrustworthy, return an explicit `DEGRADED`, `UNAVAILABLE`, or `REHEARSAL` state. Do not generate plausible-looking velocity, readiness, or coaching values from missing data.

Priority order:

1. Zero-crash demo reliability
2. Measurement correctness
3. Eliminate choppiness / race conditions
4. Deterministic core analysis without external AI
5. Safe, clear UX
6. Maintainable architecture
7. New features only after the above are stable

---

## Run & Operate

* `pnpm --filter @workspace/api-server run dev` — API server on port 5000
* `pnpm run typecheck` — workspace TypeScript typecheck
* `pnpm run build` — typecheck + build all packages
* `pnpm --filter @workspace/api-spec run codegen` — regenerate API client/Zod schemas from OpenAPI
* `pnpm --filter @workspace/db run push` — push development DB schema changes
* Required env: `DATABASE_URL` — PostgreSQL connection string
* Mobile runtime: use the configured Replit Expo workflow

A task is not complete because one package builds. Run targeted checks first, then workspace checks.

---

## Stack

* **Workspace:** pnpm workspaces, Node.js 24, TypeScript 5.9
* **Mobile:** Expo, React Native, Expo Router, `expo-camera`, `expo-sensors`, TanStack Query, AsyncStorage, `jpeg-js`
* **API:** Express 5, Zod, Pino, esbuild
* **Database:** PostgreSQL + Drizzle ORM
* **Contract:** OpenAPI → Orval-generated Zod schemas and React client
* **AI:** server-side OpenAI/Replit integration with deterministic fallback

Do not replace PostgreSQL/Drizzle or the OpenAPI/codegen workflow during Strategy A.

---

## Core Repository Map

```text
artifacts/
├── freelocity-mobile/
│   ├── app/
│   │   ├── _layout.tsx        # Expo root/providers/API configuration
│   │   ├── index.tsx          # main measurement/demo workflow
│   │   └── diary.tsx
│   └── src/
│       ├── hooks/
│       │   ├── useVbtTracker.ts
│       │   └── useConcussionTracker.ts
│       └── lib/
│           ├── vbtTracker.ts
│           ├── exerciseMeasurement.ts
│           ├── concussionTracker.ts
│           ├── security.ts
│           └── units.ts
│
└── api-server/src/
    ├── index.ts               # backend entry point
    ├── app.ts                 # Express configuration
    ├── routes/
    │   ├── index.ts
    │   ├── coaching.ts        # set-analysis orchestration
    │   ├── diary.ts
    │   └── health.ts
    ├── cns-readiness.ts
    ├── coaching-insights.ts
    ├── diary.ts
    ├── diary-context.ts
    ├── sparkden-client.ts
    └── vbt-profiles.ts

lib/
├── api-spec/openapi.yaml       # API contract source of truth
├── api-zod/                    # generated validation
├── api-client-react/           # generated client
└── db/src/schema/              # database source of truth
```

### Main runtime flow

```text
Camera / Accelerometer
        ↓
app/index.tsx
        ↓
useVbtTracker.ts
        ↓
vbtTracker.ts
        ↓
quality gate + rep metrics
        ↓
generated API client
        ↓
Express /api
        ↓
routes/coaching.ts
        ↓
history + readiness + persistence
        ↓
bounded AI explanation OR deterministic fallback
        ↓
PostgreSQL
```

React is an observer of the measurement engine. **React must not process/render raw sensor frequency.**

---

## Strategy A Demo MVP

Preferred hero flow:

```text
Launch
  ↓
API/device preflight
  ↓
Synthetic historical demo context
  ↓
Squat setup
  ↓
Stationary camera
  ↓
Real plate calibration
  ↓
Target acquisition
  ↓
Record 3–5 reps
  ↓
Stop
  ↓
Trusted result / explicit unavailable state
  ↓
One idempotent submission
  ↓
Load-matched comparison
  ↓
Performance Readiness
  ↓
Bounded AI explanation or deterministic fallback
  ↓
Measurement provenance / limitations
```

### Hero modality rule

Squat is the preferred demo because local CV is visually compelling, but it remains the hero **only if physical-device validation passes**.

If Squat cannot pass its physical reliability gate, use **Lat Pulldown IMU** as the live hero and mark Squat experimental/unavailable. Never risk judging on a modality that failed validation.

A rehearsal fixture may exist as emergency backup, but it must be visibly labeled and must never enter trusted history/readiness.

---

## P0 Triage — Fix Before Feature Work

### P0.1 — IMU render storm

Current risk: ~50 Hz accelerometer samples can propagate into React `setState`.

Required:

```text
sensor @ ~50 Hz
    ↓
mutable tracker/ref
    ↓
NO render per sample
    ↓
UI snapshot at bounded cadence or meaningful state changes
```

Primary files:

* `artifacts/freelocity-mobile/src/hooks/useVbtTracker.ts`
* `artifacts/freelocity-mobile/app/index.tsx`

### P0.2 — Squat calibration

Squat must not become `READY` unless calibration truly succeeds.

Physical scale must use:

```text
meters_per_pixel =
actual_reference_diameter_m / observed_reference_diameter_px
```

Do not assume a fixed observed diameter such as `300 px`.

Primary files:

* `app/index.tsx`
* `src/lib/vbtTracker.ts`
* `src/lib/exerciseMeasurement.ts`

### P0.3 — Constrained CV tracking

The visible red guide/ROI must actually constrain search. Do not use the largest moving component across the entire frame as the sole target selector.

Preferred flow:

```text
calibrated target/ROI
  ↓
local candidate search
  ↓
candidate score
  ↓
confidence gate
  ↓
accepted centroid OR unavailable
```

### P0.4 — Stationary camera

Squat instructions must require a stationary phone/stand/tripod. Handheld camera motion contaminates pixel displacement and therefore velocity.

### P0.5 — Canonical measurement ownership

Do not derive conflicting canonical rep/velocity results independently on mobile and backend.

Preferred Strategy A boundary:

```text
device derives physical measurement
  ↓
server validates provenance/ranges
  ↓
server adds history/readiness/coaching
```

The feedback page must never combine a server rep count with a different mobile rep table.

### P0.6 — Async lifecycle/races

In-flight camera work must not commit after Stop/reset/unmount or into a new recording.

Use a recording-session identity/cancellation guard. Stale async work must be ignored.

All temporary and recording accelerometer subscriptions must be removed on:

* completion
* cancellation
* reset
* unmount
* error

### P0.7 — AI cannot block core success

Core measurement analysis must succeed without AI.

Required order:

```text
validate measurement
  ↓
deterministic analytics
  ↓
persist successful set result
  ↓
bounded AI enrichment
  ↓
validated AI output OR deterministic fallback
```

Never strand the user indefinitely on `Analyzing…` because an external provider is slow.

Primary files:

* `artifacts/api-server/src/routes/coaching.ts`
* `artifacts/api-server/src/coaching-insights.ts`

### P0.8 — Idempotent submission

A retry of the same capture must not insert another historical set.

Add a stable capture/session ID and enforce uniqueness/idempotency at persistence.

### P0.9 — Runtime configuration

Never allow an API base URL such as `https://undefined`.

Validate required configuration during startup/preflight and expose an actionable failure state.

Primary file:

* `artifacts/freelocity-mobile/app/_layout.tsx`

---

## Performance Rules

### Sensor path

* Keep raw high-frequency values in tracker objects, refs, or buffers.
* Publish UI state at a bounded cadence.
* Do not place 50 Hz streams in global/React state.

### Camera path

Avoid unnecessary per-frame:

* full-frame scans
* duplicate buffer copies
* object-heavy intermediate arrays
* repeated allocations
* React state updates

Prefer ROI-constrained work after calibration/acquisition.

Do **not** rewrite to a native frame processor during Strategy A unless the optimized snapshot path still fails the physical acceptance gate.

### Network/API

Every demo-critical request needs:

* bounded timeout behavior
* clear terminal error state
* duplicate-submit protection
* deterministic fallback for optional dependencies

### Database

Do not add Redis/Kafka to hide application-level issues. PostgreSQL + Drizzle is sufficient for this MVP.

---

## Measurement Quality & Provenance

Use explicit quality semantics:

```text
TRUSTED
DEGRADED
UNAVAILABLE
REHEARSAL
```

Rules:

* `TRUSTED` may enter trusted history/readiness.
* `DEGRADED` is excluded from trusted baselines unless an explicit validated policy allows it.
* `UNAVAILABLE` contains no fabricated physical metrics.
* `REHEARSAL` never enters trusted history/readiness.

Preserve provenance where available:

* measurement source
* capture/sample rate
* calibration metadata
* confidence/quality
* manual edits
* rehearsal flag

---

## Product & Safety Boundaries

### Readiness

User-facing terminology should be **Performance Readiness** or **Velocity Readiness**, not a direct claim of measuring the central nervous system.

Describe only what the calculation actually supports: a load-matched velocity performance trend.

### AI

AI may explain deterministic metrics and historical context.

AI must not:

* invent measurements
* override quality gates
* diagnose injury
* provide return-to-play clearance
* convert unavailable data into confident conclusions

### Recovery/concussion

The current concussion/recovery scoring prototype is **not part of the Strategy A hero demo**.

Do not surface unvalidated:

* concussion risk tiers
* pupil scoring
* cognitive scoring
* balance risk models
* return-to-play decisions

If recovery remains accessible, keep it separate from training readiness and clearly non-diagnostic.

---

## Scope Freeze

Until the hero path passes all exit gates, do not spend time on:

* new exercises
* social/community features
* new diary functionality
* new concussion models
* pupil/cognitive/balance experiments
* Sparkden enhancements
* microservices
* Kafka
* Redis
* Kubernetes
* model fine-tuning
* major visual redesign
* speculative abstractions

Fix the root causes first.

---

## Contract & Data Rules

`lib/api-spec/openapi.yaml` is the API source of truth.

When the contract changes:

1. update OpenAPI
2. regenerate Zod/client artifacts
3. update implementation
4. run typecheck/tests

Do not hide contract drift with broad casts or duplicate handwritten interfaces.

Historical data must eventually have explicit owner/session scope. Do not build new logic around a permanently global single-user database assumption.

Raw IMU payload size grows with recording duration. Use intentional recording bounds and explicit body-size configuration rather than relying on Express defaults.

---

## Error Handling

Every asynchronous state must terminate.

No indefinite:

* loading
* analyzing
* calibrating
* recording
* saving

Distinguish at least:

* permission denied
* camera unavailable
* sensor unavailable
* calibration failed
* tracking lost
* measurement unavailable
* network timeout
* API validation failure
* insufficient history
* AI unavailable

AI failure is not measurement failure.

Prefer structured errors containing:

* `code`
* `message`
* `recoverable`
* `correlationId`
* optional safe details

---

## Logging & Privacy

Use structured server logs with fields such as:

* `requestId`
* `captureId`
* `operation`
* `exercise`
* `measurementSource`
* `measurementQuality`
* `processingMs`
* `aiMs`
* `aiFallbackUsed`

Do not log:

* raw camera frames
* raw diary text
* secrets
* unnecessary sensitive context

Prefer local image processing and transmit only the minimum data needed for server analytics.

---

## Strategy A Implementation Order

### Phase 1 — Performance & Stability

Modify first:

1. `src/hooks/useVbtTracker.ts`

   * remove sensor-frequency React rendering

2. `app/index.tsx`

   * stale async protection
   * sensor cleanup
   * duplicate Stop/submission protection
   * clear terminal failure states
   * stationary-camera workflow

3. `src/lib/vbtTracker.ts`

   * calibration correctness
   * ROI-constrained tracking
   * hot-path allocation cleanup
   * quality/confidence

4. `api-server/src/routes/coaching.ts`

   * deterministic result before optional AI
   * bounded external work
   * consistent measurement ownership

5. `api-server/src/app.ts`

   * body limits
   * centralized errors
   * request correlation

6. `app/_layout.tsx`

   * runtime/API configuration validation

### Phase 2 — Core/Rubric Correctness

* real Squat calibration
* canonical measurement ownership
* capture idempotency
* provenance/quality contract
* Performance Readiness terminology
* AI guardrails/explainability
* synthetic demo history clearly labeled
* unsafe recovery scoring kept out of hero flow

### Phase 3 — Senior-Level Polish

Only after stability:

* split `app/index.tsx` by feature/state
* split `routes/coaching.ts` into application/domain services
* typed measurement state machine
* accessibility pass
* structured observability
* ADR/README cleanup
* dead-code deletion
* performance benchmark report

Target architecture remains a **modular monolith**, not microservices.

---

## Verification Gates

Run relevant targeted tests plus:

* `pnpm run typecheck`
* `pnpm run build`
* tracker tests
* readiness tests
* coaching tests
* diary tests if touched
* schema verification if DB touched
* API smoke test
* iOS/Android bundle generation when mobile runtime changes

Maintain tests proving these invariants:

```text
rehearsal data NEVER enters trusted history
untrusted provenance NEVER enters readiness
untrusted measurements NEVER produce confident coaching
insufficient history NEVER produces confident readiness
AI failure NEVER prevents deterministic analysis
duplicate capture NEVER creates duplicate history
stale camera work NEVER mutates a stopped/new session
sensor listeners are removed on cleanup
failed calibration NEVER becomes READY
unavailable measurement NEVER receives fake velocity
```

### Physical Squat acceptance gate

Before using Squat as the live hero, validate on real hardware/gym conditions and record:

* actual processed FPS
* median and p95 observation latency
* tracked-frame percentage
* tracking loss/reacquisition
* calibration correctness
* repeated-set consistency

Target:

* approximately ≥2 processed observations/sec sustained
* median latency ≤~600 ms
* p95 latency ≤~1 s
* no growing capture queue
* ≥~80% accepted/tracked frames in a controlled short set
* reasonable reacquisition after brief occlusion

If these fail, switch the hero demo to Lat Pulldown rather than hiding the failure.

---

## Code Debt Cleanup

After runtime stability is proven, verify references and remove/archive candidates such as:

```text
server.py
vbt_tracker.py
artifacts/frevelocity-mobile/
lib/integrations/openai_ai_integrations/
unused conversation/message schemas
stale prompt transcript assets
unused security helpers
```

Do **not** delete the intentional generated-contract stack:

```text
lib/api-spec
lib/api-zod
lib/api-client-react
lib/db
```

---

## Replit AI Operating Rules

When modifying this repository:

1. Read this file and `docs/FRELOCITY_MASTER_SYSTEM_SPECIFICATION.md`.
2. State which Strategy A defect or exit criterion the change addresses.
3. Inspect the current implementation before editing.
4. Fix the root cause with the smallest coherent change.
5. Do not introduce a second source of truth.
6. Do not weaken validation merely to make the demo appear successful.
7. Never fabricate sensor data outside clearly labeled rehearsal fixtures.
8. Change OpenAPI first when API semantics change.
9. Preserve deterministic fallback behavior.
10. Add/update tests for the affected invariant.
11. Run targeted checks, then workspace checks.
12. Report files changed, root cause, before/after behavior, tests run, and remaining risk.
13. Never claim a physical-device problem is solved until verified on physical hardware.

---

## Definition of Demo-Ready

Strategy A is complete only when:

* hero flow repeats multiple times without crashes
* UI stays responsive during recording
* no stale sensor/camera work leaks between sessions
* calibration is physically meaningful
* canonical metrics are internally consistent
* Stop always terminates cleanly
* analysis always reaches a terminal state
* AI outage still yields deterministic useful output
* retries do not duplicate history
* untrusted measurements are visibly withheld
* fallback/rehearsal provenance is explicit
* required tests/typechecks/builds pass
* selected hero modality passes physical-device validation

Until all of these are true, prioritize stabilization over feature expansion.

---

## Gotchas

* Squat currently uses snapshot → Base64/JPEG decode → RGBA → local JavaScript CV; this path is CPU/latency sensitive.
* A visible tracking guide is useless unless the tracker actually constrains search to it.
* Physical scale requires both real-world reference size and observed pixel size.
* `READY` must mean successful calibration, not merely a button press.
* Raw IMU payload size grows quickly with recording duration.
* Optional AI/external history must never be required for core measurement success.
* Rehearsal/test data must remain isolated from trusted baselines.
* OpenAPI changes require regenerated client/Zod artifacts.
* Bundle success does not prove real physical measurement quality.

---

## Pointers

* `docs/FRELOCITY_MASTER_SYSTEM_SPECIFICATION.md` — measurement/product specification and acceptance criteria
* `lib/api-spec/openapi.yaml` — API contract
* `lib/db/src/schema/` — database schema
* `artifacts/freelocity-mobile/app/index.tsx` — main measurement orchestration
* `artifacts/freelocity-mobile/src/hooks/useVbtTracker.ts` — React/tracker bridge
* `artifacts/freelocity-mobile/src/lib/vbtTracker.ts` — local measurement engine
* `artifacts/api-server/src/routes/coaching.ts` — set-analysis orchestration
* `artifacts/api-server/src/cns-readiness.ts` — current readiness calculation
* `artifacts/api-server/src/coaching-insights.ts` — deterministic coaching fallback

When documentation and implementation disagree, resolve the discrepancy explicitly. Do not silently assume either side is correct.
::: 

---
name: Readiness provenance
description: Trust boundary for readiness baselines and treatment of historical rows without source records.
---

Only prior records explicitly labelled `mobile_imu` may influence readiness. Existing rows whose origin was not captured stay `legacy_unclassified` rather than being backfilled as measured; test fixtures remain retained but excluded.

**Why:** A historical velocity value without a source label might have come from validation or demonstration activity. Classifying it as physical measurement would silently corrupt the training baseline.

**How to apply:** Any new ingestion route must declare provenance. If a new source is considered trustworthy, add it deliberately to the readiness trust policy and regression cases instead of relying on a broad default.
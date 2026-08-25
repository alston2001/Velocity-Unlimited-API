---
name: Native CV frame support
description: Squat CV must withhold velocity when a platform cannot deliver decodable camera pixels.
---

Squat velocity may only be reported after real camera frames have been decoded into pixels and processed by the classical tracker. The web capture path uses throttled snapshots; native Expo Go builds currently cannot supply a compatible pixel buffer, so they must present an unavailable state rather than estimating velocity.

**Why:** A visible camera preview is not measurement data. Treating it as such would create fabricated velocity, readiness, and coaching inputs.

**How to apply:** Any native frame-processor or decoder addition must feed the same local tracker, preserve plate scale, lost-frame confidence, racking trim, and manual review, and be verified on physical iOS and Android devices before enabling measured Squat velocity.
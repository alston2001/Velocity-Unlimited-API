---
name: Native CV frame support
description: Squat CV must withhold velocity when a platform cannot deliver decodable camera pixels.
---

Squat velocity may only be reported after real camera frames have been decoded into pixels and processed by the classical tracker. The current supported path captures throttled JPEG snapshots and decodes them with the pure-JS `jpeg-js` decoder into RGBA buffers on both web and native.

**Why:** A visible camera preview is not measurement data. Treating it as such would create fabricated velocity, readiness, and coaching inputs; a pure-JS decoder avoids an incompatible native frame-processor dependency.

**How to apply:** Any future frame-path change must feed the same local tracker, preserve plate scale, lost-frame confidence, racking trim, and manual review, and be verified on physical iOS and Android devices before enabling measured Squat velocity.
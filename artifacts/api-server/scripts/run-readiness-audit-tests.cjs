const assert = require("node:assert/strict");
const {
  canonicalizeExerciseName,
  computeReadinessFromHistory,
  filterTrustedReadinessHistory,
  selectLoadMatchedHistory,
} = require("../.readiness-test/cns-readiness.cjs");

const row = (id, overrides = {}) => ({
  id,
  createdAt: `2026-08-0${id}T12:00:00.000Z`,
  date: `2026-08-0${id}`,
  meanVelocityMs: 0.7,
  peakVelocityMs: 0.85,
  firstRepPeakMs: 0.8,
  weightKg: 60,
  estimated1RmPct: 75,
  actualReps: 5,
  velocityLossPct: 10,
  fatigueLevel: "Moderate — productive stimulus",
  measurementSource: "mobile_imu",
  provenance: "calibrated mobile IMU batch accepted by /analyze-set",
  ...overrides,
});

const trusted = [row("1"), row("2", { firstRepPeakMs: 0.82 }), row("3", { firstRepPeakMs: 0.78 })];
const fixture = row("4", {
  measurementSource: "test_fixture",
  provenance: "demo history fixture",
  firstRepPeakMs: 2.8,
  meanVelocityMs: 2.5,
});
const otherLoad = row("5", { weightKg: 80 });

assert.equal(canonicalizeExerciseName("  SQUAT   "), "squat");
assert.equal(filterTrustedReadinessHistory([...trusted, fixture]).length, 3, "fixture rows must not be trusted");
assert.deepEqual(selectLoadMatchedHistory([...trusted, otherLoad], 60).map((item) => item.id), ["1", "2", "3"]);

const report = computeReadinessFromHistory([...trusted, fixture, otherLoad], 60, 0.8);
assert.equal(report.dataPoints, 3, "only prior trusted and load-matched rows count");
assert.equal(report.baselineVelocityMs, 0.8);
assert.equal(report.score, 100);
assert.deepEqual(report.matchedHistory.map((item) => item.id), ["1", "2", "3"]);
assert.equal(report.history.some((item) => item.id === "4"), false, "demo/test data must not enter readiness history");

const insufficient = computeReadinessFromHistory(trusted.slice(0, 2), 60, 0.8);
assert.equal(insufficient.score, null);
assert.equal(insufficient.level, "Insufficient data");

const invalidCurrentSet = computeReadinessFromHistory(trusted, 60, null);
assert.equal(invalidCurrentSet.score, null, "an unavailable current first rep must not score readiness");

console.log("readiness audit tests passed");
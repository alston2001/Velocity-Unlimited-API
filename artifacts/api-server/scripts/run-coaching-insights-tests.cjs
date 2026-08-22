const assert = require("node:assert/strict");
const {
  buildHistoricalComparison,
  buildDeterministicCoaching,
} = require("../.coaching-test/coaching-insights.cjs");

const history = [0.5, 0.52, 0.48].map((meanVelocityMs, index) => ({
  date: `2026-08-0${index + 1}`,
  meanVelocityMs,
  peakVelocityMs: meanVelocityMs + 0.1,
  firstRepPeakMs: meanVelocityMs + 0.08,
  weightKg: 60,
  estimated1RmPct: 75,
  actualReps: 5,
  velocityLossPct: 12,
  fatigueLevel: "Moderate — productive stimulus",
}));

const faster = buildHistoricalComparison("Squat", 60, 0.57, history);
assert.equal(faster.deltaPct, 14);
assert.match(faster.insight, /14.0% faster/);

const slower = buildHistoricalComparison("Squat", 60, 0.42, history);
assert.equal(slower.deltaPct, -16);
assert.match(slower.insight, /16.0% slower/);
assert.match(slower.insight, /reducing load 2–5%/);

const noHistory = buildHistoricalComparison("Custom Tempo Lift", 60, 0.55, []);
assert.equal(noHistory.deltaPct, null);
assert.match(noHistory.insight, /No load-matched history/);

const coaching = buildDeterministicCoaching({
  historicalComparison: slower,
  velocityLossPct: 22,
  fatigueLevel: "High — approaching failure",
  cnsReadinessScore: 78,
  motorReadinessLevel: "Low",
  baselineVelocityMs: 0.58,
});
assert.match(coaching, /16.0% slower/);
assert.match(coaching, /Velocity loss reached 22.0%/);
assert.match(coaching, /Readiness is 78\/100/);

console.log("coaching insight tests passed");
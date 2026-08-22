const assert = require("node:assert/strict");
const { ExerciseTracker } = require("../.tracker-test/vbtTracker.js");

const rest = Array.from({ length: 40 }, () => 9.81);

function calibrateTracker() {
  const tracker = new ExerciseTracker("FREE_WEIGHT_SIDE");
  assert.equal(tracker.calibrateImu(rest), true);
  return tracker;
}

{
  const tracker = calibrateTracker();
  for (let index = 0; index < 180; index++) {
    tracker.updateImu(9.81, index * 20);
  }
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.currentVelocity, 0);
  assert.equal(snapshot.reps.length, 0);
  assert.equal(tracker.stopSet().completedSet.measurementStatus, "UNAVAILABLE");
}

{
  const tracker = calibrateTracker();
  let timestamp = 0;
  for (let index = 0; index < 12; index++) {
    tracker.updateImu(9.81, timestamp += index % 2 ? 15 : 45);
  }
  for (let index = 0; index < 70; index++) {
    tracker.updateImu(10.81, timestamp += index % 2 ? 15 : 45);
  }
  for (let index = 0; index < 140; index++) {
    tracker.updateImu(8.81, timestamp += index % 2 ? 15 : 45);
  }
  const set = tracker.stopSet().completedSet;
  assert.ok(set.reps.length >= 1);
  assert.ok(set.reps.every((rep) => Number.isFinite(rep.meanVelocity) && Number.isFinite(rep.peakVelocity)));
  assert.equal(set.measurementStatus, "MEASURED");
}

{
  const tracker = new ExerciseTracker("FREE_WEIGHT_SIDE");
  tracker.updateImu(9.81, 0);
  assert.equal(tracker.snapshot().currentVelocity, null);
  assert.equal(tracker.stopSet().completedSet.unavailableReason, "IMU rest calibration is required before recording.");
}

console.log("tracker tests passed");
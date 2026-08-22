export type TrackerMode = 'FREE_WEIGHT_SIDE' | 'PULLEY_FRONT';
export type TrackerPhase = 'IDLE' | 'ACTIVE' | 'COOLDOWN';

export type Point = { x: number; y: number };

export type RepMetric = {
  repNumber: number;
  repTimeSec: number;
  peakVelocity: number | null;
  meanVelocity: number | null;
  measurementStatus?: 'MEASURED' | 'UNAVAILABLE';
  unavailableReason?: string;
};

export type SetSummary = {
  reps: RepMetric[];
  meanRepTime: number;
  topSpeed: number;
  peakVelocities: number[];
  consistencyScore: number;
  durationSec?: number;
  sampleCount?: number;
  velocityLossPct?: number | null;
  dataQuality?: 'GOOD' | 'DEGRADED' | 'DEMO';
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  inferenceSource?: 'IMU' | 'MANUAL' | 'DEMO';
  limitations?: string[];
  measurementStatus?: 'MEASURED' | 'UNAVAILABLE' | 'REHEARSAL';
  unavailableReason?: string;
};

export type TrackerSnapshot = {
  reps: RepMetric[];
  currentVelocity: number | null;
  displacement: number;
  phase: TrackerPhase;
  centroid: Point | null;
  trajectory: Point[];
  completedSet: SetSummary | null;
};

export interface ExerciseTrackerEngine {
  readonly reps: RepMetric[];
  readonly currentVelocity: number | null;
  readonly displacement: number;
  readonly phase: TrackerPhase;
  readonly centroid: Point | null;
  readonly trajectory: Point[];
  readonly completedSet: SetSummary | null;
  processFrame(
    rgba: Uint8ClampedArray | null,
    width: number,
    height: number,
    dt: number,
  ): TrackerSnapshot;
  updateImu(accelMs2: number, timestampMs: number): TrackerSnapshot;
  calibrateImu(restSamplesMs2: number[]): boolean;
  readonly calibrated: boolean;
  manualIncrementRep(): TrackerSnapshot;
  reset(): TrackerSnapshot;
  calibratePlate(observedPx: number): boolean;
  setCustomReference(referenceMeters: number, observedPx: number): boolean;
  snapshot(): TrackerSnapshot;
}

const PLATE_DIAMETER_M = 0.45;
const DEFAULT_PLATE_PX = 300;
const IDLE_NOISE_FLOOR = 0.035;
const MOTION_SPIKE_THRESHOLD = 0.09;
const STILLNESS_SECONDS = 2.5;
const MIN_REP_VELOCITY = 0.015;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function grayAt(buffer: Uint8ClampedArray, width: number, x: number, y: number) {
  const offset = (y * width + x) * 4;
  return (
    buffer[offset]! * 0.299 +
    buffer[offset + 1]! * 0.587 +
    buffer[offset + 2]! * 0.114
  );
}

function hsvAt(buffer: Uint8ClampedArray, width: number, x: number, y: number) {
  const offset = (y * width + x) * 4;
  const red = buffer[offset]! / 255;
  const green = buffer[offset + 1]! / 255;
  const blue = buffer[offset + 2]! / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

export function otsuThreshold(values: Float32Array) {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[clamp(Math.round(value), 0, 255)]!++;
  const total = values.length;
  let sum = 0;
  for (let index = 0; index < 256; index++) sum += index * histogram[index]!;
  let weightBackground = 0;
  let sumBackground = 0;
  let bestVariance = 0;
  let threshold = 0;
  for (let index = 0; index < 256; index++) {
    weightBackground += histogram[index]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += index * histogram[index]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground *
      weightForeground *
      (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = index;
    }
  }
  return threshold;
}

/**
 * Mode A pipeline: HSV glare masking → Otsu foreground threshold → Canny-like
 * gradient edges → largest connected moving component centroid.
 */
export function findSideProfileCentroid(
  current: Uint8ClampedArray,
  previous: Uint8ClampedArray | null,
  width: number,
  height: number,
): Point | null {
  if (width < 8 || height < 8 || current.length < width * height * 4) {
    return null;
  }
  const grayscale = new Float32Array(width * height);
  const motion = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const hsv = hsvAt(current, width, x, y);
      const value = grayAt(current, width, x, y);
      grayscale[index] = value;
      const glare = hsv.v * 255 > 240;
      const diff =
        previous && previous.length >= width * height * 4
          ? Math.abs(value - grayAt(previous, width, x, y))
          : 255;
      motion[index] = glare || diff < 8 ? 0 : 1;
    }
  }

  const threshold = otsuThreshold(grayscale);
  const edge = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const gx = grayscale[index + 1]! - grayscale[index - 1]!;
      const gy = grayscale[index + width]! - grayscale[index - width]!;
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      edge[index] =
        motion[index] && (grayscale[index]! > threshold || magnitude > 22)
          ? 1
          : 0;
    }
  }

  const visited = new Uint8Array(width * height);
  let largest: Point[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const start = y * width + x;
      if (!edge[start] || visited[start]) continue;
      const queue = [start];
      const component: Point[] = [];
      visited[start] = 1;
      while (queue.length) {
        const index = queue.pop()!;
        const pointX = index % width;
        const pointY = Math.floor(index / width);
        component.push({ x: pointX, y: pointY });
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nextX = pointX + dx;
          const nextY = pointY + dy;
          const next = nextY * width + nextX;
          if (
            nextX > 0 &&
            nextX < width - 1 &&
            nextY > 0 &&
            nextY < height - 1 &&
            edge[next] &&
            !visited[next]
          ) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
      if (component.length > largest.length) largest = component;
    }
  }
  return largest.length < 4
    ? null
    : {
        x: largest.reduce((sum, point) => sum + point.x, 0) / largest.length,
        y: largest.reduce((sum, point) => sum + point.y, 0) / largest.length,
      };
}

/**
 * Mode B vertical optical-flow/motion-blob approximation. It uses
 * zero-normalized vertical block correlation and returns pixel displacement.
 */
export function estimatePulleyDisplacement(
  current: Uint8ClampedArray,
  previous: Uint8ClampedArray | null,
  width: number,
  height: number,
) {
  if (!previous || current.length < width * height * 4) return 0;
  const radius = 4;
  const search = Math.min(24, Math.floor(height / 5));
  const x = Math.floor(width / 2);
  const y = Math.floor(height / 2);
  let bestOffset = 0;
  let bestScore = -Infinity;
  const patchMean = (buffer: Uint8ClampedArray, offsetY: number) => {
    let sum = 0;
    let count = 0;
    for (let py = -radius; py <= radius; py++) {
      for (let px = -radius; px <= radius; px++) {
        const sampleX = clamp(x + px, 0, width - 1);
        const sampleY = clamp(y + offsetY + py, 0, height - 1);
        sum += grayAt(buffer, width, sampleX, sampleY);
        count++;
      }
    }
    return sum / count;
  };
  const previousMean = patchMean(previous, 0);
  for (let offset = -search; offset <= search; offset++) {
    const score = -Math.abs(previousMean - patchMean(current, offset));
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

function variance(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

class Kalman3D {
  private state: [number, number, number] = [0, 0, 0];
  private covariance = [
    [0.1, 0, 0],
    [0, 0.1, 0],
    [0, 0, 0.4],
  ];

  predict(acceleration: number, dt: number) {
    const dt2 = dt * dt;
    this.state = [
      this.state[0] + this.state[1] * dt + 0.5 * this.state[2] * dt2,
      this.state[1] + this.state[2] * dt,
      this.state[2] * 0.92 + acceleration * 0.08,
    ];
    this.covariance[0]![0]! += 0.002;
    this.covariance[1]![1]! += 0.03;
    this.covariance[2]![2]! += 0.08;
  }

  measurePosition(position: number) {
    const residual = position - this.state[0];
    if (Math.abs(residual) > 0.08) return;
    const gain = this.covariance[0]![0]! / (this.covariance[0]![0]! + 0.004);
    this.state[0] += gain * residual;
    this.state[1] += gain * residual * 0.6;
    this.state[2] += gain * residual * 0.2;
    this.covariance[0]![0]! *= 1 - gain;
  }

  values() {
    return { position: this.state[0], velocity: this.state[1], acceleration: this.state[2] };
  }

  reset() {
    this.state = [0, 0, 0];
    this.covariance = [
      [0.1, 0, 0],
      [0, 0.1, 0],
      [0, 0, 0.4],
    ];
  }
}

export class ExerciseTracker implements ExerciseTrackerEngine {
  readonly mode: TrackerMode;
  private readonly kalman = new Kalman3D();
  private previousFrame: Uint8ClampedArray | null = null;
  private metersPerPixel = PLATE_DIAMETER_M / DEFAULT_PLATE_PX;
  private phaseValue: TrackerPhase = 'IDLE';
  private repsValue: RepMetric[] = [];
  private velocityValue: number | null = null;
  private displacementValue = 0;
  private centroidValue: Point | null = null;
  private trajectoryValue: Point[] = [];
  private completedSetValue: SetSummary | null = null;
  private previousVelocity = 0;
  private previousDisplacement = 0;
  private stillnessSeconds = 0;
  private activeSeconds = 0;
  private lastRepAt = 0;
  private idleFrameCounter = 0;
  private calibratedValue = false;
  private gravityBaselineMs2 = 0;
  private lastImuTimestampMs: number | null = null;
  private filteredAccelMs2 = 0;
  private repVelocitySamples: number[] = [];
  private repStartSeconds = 0;

  constructor(mode: TrackerMode) {
    this.mode = mode;
  }

  get reps() { return this.repsValue; }
  get currentVelocity() { return this.velocityValue; }
  get calibrated() { return this.calibratedValue; }
  get displacement() { return this.displacementValue; }
  get phase() { return this.phaseValue; }
  get centroid() { return this.centroidValue; }
  get trajectory() { return this.trajectoryValue; }
  get completedSet() { return this.completedSetValue; }

  processFrame(
    rgba: Uint8ClampedArray | null,
    width: number,
    height: number,
    dt: number,
  ) {
    if (this.phaseValue === 'COOLDOWN') return this.snapshot();
    const previous = this.previousFrame;
    let motion = 0;
    if (rgba && rgba.length >= width * height * 4) {
      if (this.mode === 'FREE_WEIGHT_SIDE') {
        const lastCentroid = this.centroidValue;
        const centroid = findSideProfileCentroid(rgba, previous, width, height);
        if (centroid) {
          motion = lastCentroid ? Math.abs(centroid.y - lastCentroid.y) : 0;
          this.centroidValue = centroid;
          this.trajectoryValue = [...this.trajectoryValue, centroid].slice(-60);
          if (lastCentroid) {
            this.kalman.measurePosition(
              this.displacementValue - (centroid.y - lastCentroid.y) * this.metersPerPixel,
            );
          }
        }
      } else {
        const deltaPixels = estimatePulleyDisplacement(rgba, previous, width, height);
        motion = Math.abs(deltaPixels);
        this.displacementValue += deltaPixels * this.metersPerPixel;
        this.kalman.measurePosition(this.displacementValue);
      }
      this.previousFrame = rgba.slice();
      this.velocityValue = this.kalman.values().velocity;
    }
    if (this.phaseValue === 'IDLE') {
      this.idleFrameCounter++;
      if (this.idleFrameCounter % 4 === 0 && motion > IDLE_NOISE_FLOOR) {
        this.phaseValue = 'ACTIVE';
      }
    }
    this.advancePhase(motion, dt);
    return this.snapshot();
  }

  calibrateImu(restSamplesMs2: number[]) {
    if (restSamplesMs2.length < 20 || restSamplesMs2.some((value) => !Number.isFinite(value))) {
      return false;
    }
    const mean = restSamplesMs2.reduce((sum, value) => sum + value, 0) / restSamplesMs2.length;
    const varianceValue = variance(restSamplesMs2);
    if (!Number.isFinite(mean) || varianceValue > 0.35 ** 2) return false;
    this.gravityBaselineMs2 = mean;
    this.calibratedValue = true;
    this.lastImuTimestampMs = null;
    this.filteredAccelMs2 = 0;
    this.velocityValue = 0;
    return true;
  }

  updateImu(accelMs2: number, timestampMs: number) {
    if (this.phaseValue === 'COOLDOWN') return this.snapshot();
    if (!this.calibratedValue || !Number.isFinite(accelMs2) || !Number.isFinite(timestampMs)) {
      this.velocityValue = null;
      return this.snapshot();
    }
    if (this.lastImuTimestampMs === null) {
      this.lastImuTimestampMs = timestampMs;
      return this.snapshot();
    }
    const dt = (timestampMs - this.lastImuTimestampMs) / 1000;
    this.lastImuTimestampMs = timestampMs;
    if (dt <= 0 || dt > 0.25) {
      this.velocityValue = 0;
      this.filteredAccelMs2 = 0;
      this.kalman.reset();
      return this.snapshot();
    }

    const residual = accelMs2 - this.gravityBaselineMs2;
    this.filteredAccelMs2 = this.filteredAccelMs2 * 0.8 + residual * 0.2;
    const motion = Math.abs(this.filteredAccelMs2) > 0.45 ? Math.abs(this.filteredAccelMs2) : 0;
    if (motion > 0) {
      const previousVelocity = this.velocityValue ?? 0;
      this.velocityValue = clamp(
        previousVelocity + this.filteredAccelMs2 * dt,
        -4,
        4,
      );
      this.displacementValue += ((previousVelocity + this.velocityValue) / 2) * dt;
    } else {
      this.velocityValue = Math.abs(this.velocityValue ?? 0) < 0.04
        ? 0
        : (this.velocityValue ?? 0) * Math.exp(-8 * dt);
    }

    if (this.phaseValue === 'IDLE' && motion > 0) {
      this.phaseValue = 'ACTIVE';
      this.activeSeconds = 0;
      this.repStartSeconds = 0;
    }
    this.advancePhase(motion, dt);
    return this.snapshot();
  }

  private advancePhase(motion: number, dt: number) {
    if (this.phaseValue !== 'ACTIVE') return;
    this.activeSeconds += dt;
    const velocity = this.velocityValue;
    if (velocity === null) return;
    const crossedBottom =
      this.activeSeconds > 0.12 &&
      Math.abs(velocity) > MIN_REP_VELOCITY &&
      ((this.previousVelocity < -MIN_REP_VELOCITY && velocity >= 0) ||
        (this.previousVelocity > MIN_REP_VELOCITY && velocity <= 0));
    if (
      crossedBottom &&
      Math.abs(this.displacementValue - this.previousDisplacement) > 0.005
    ) {
      this.completeRep();
    }
    this.previousVelocity = velocity;
    this.previousDisplacement = this.displacementValue;
    if (motion < IDLE_NOISE_FLOOR && Math.abs(velocity) < MIN_REP_VELOCITY) {
      this.stillnessSeconds += dt;
    } else {
      this.stillnessSeconds = 0;
    }
    if (this.stillnessSeconds >= STILLNESS_SECONDS) {
      if (this.repsValue.length > 0) {
        this.phaseValue = 'COOLDOWN';
        this.completedSetValue = this.finalizeSet();
      } else {
        this.phaseValue = 'IDLE';
        this.activeSeconds = 0;
        this.velocityValue = 0;
      }
    }
  }

  private completeRep() {
    if (this.repVelocitySamples.length < 4) return;
    const repTimeSec = this.activeSeconds - this.repStartSeconds;
    if (repTimeSec < 0.4 || repTimeSec > 8) {
      this.repVelocitySamples = [];
      this.repStartSeconds = this.activeSeconds;
      return;
    }
    const peakVelocity = Math.max(...this.repVelocitySamples);
    const meanVelocity = this.repVelocitySamples.reduce((sum, value) => sum + value, 0) / this.repVelocitySamples.length;
    this.repsValue = [
      ...this.repsValue,
      {
        repNumber: this.repsValue.length + 1,
        repTimeSec,
        peakVelocity,
        meanVelocity,
        measurementStatus: 'MEASURED',
      },
    ];
    this.lastRepAt = this.activeSeconds;
    this.repVelocitySamples = [];
    this.repStartSeconds = this.activeSeconds;
  }

  private finalizeSet(): SetSummary {
    const times = this.repsValue.map((rep) => rep.repTimeSec);
    const peaks = this.repsValue.map((rep) => rep.peakVelocity);
    const meanRepTime = times.length
      ? times.reduce((sum, value) => sum + value, 0) / times.length
      : 0;
    const topSpeed = peaks.length ? Math.max(...peaks) : 0;
    const meanPeak = peaks.length
      ? peaks.reduce((sum, value) => sum + value, 0) / peaks.length
      : 0;
    const stdDev = Math.sqrt(variance(peaks));
    return {
      reps: [...this.repsValue],
      meanRepTime,
      topSpeed,
      peakVelocities: peaks,
      consistencyScore: meanPeak > 0 ? clamp(100 * (1 - stdDev / meanPeak), 0, 100) : 0,
    };
  }

  manualIncrementRep() {
    return this.snapshot();
  }

  stopSet() {
    if (this.phaseValue === 'COOLDOWN') return this.snapshot();
    this.phaseValue = 'COOLDOWN';
    this.completedSetValue = this.repsValue.length > 0
      ? this.finalizeSet()
      : {
          reps: [],
          meanRepTime: 0,
          topSpeed: 0,
          peakVelocities: [],
          consistencyScore: 0,
          measurementStatus: 'UNAVAILABLE',
          unavailableReason: this.calibratedValue
            ? 'No complete movement cycle was detected.'
            : 'IMU rest calibration is required before recording.',
        };
    return this.snapshot();
  }

  calibratePlate(observedPx: number) {
    if (this.mode !== 'FREE_WEIGHT_SIDE' || observedPx <= 2) return false;
    this.metersPerPixel = PLATE_DIAMETER_M / observedPx;
    return true;
  }

  setCustomReference(referenceMeters: number, observedPx: number) {
    if (this.mode !== 'PULLEY_FRONT' || referenceMeters <= 0 || observedPx <= 2) {
      return false;
    }
    this.metersPerPixel = referenceMeters / observedPx;
    return true;
  }

  reset() {
    this.previousFrame = null;
    this.phaseValue = 'IDLE';
    this.repsValue = [];
    this.velocityValue = 0;
    this.displacementValue = 0;
    this.centroidValue = null;
    this.trajectoryValue = [];
    this.completedSetValue = null;
    this.previousVelocity = 0;
    this.previousDisplacement = 0;
    this.stillnessSeconds = 0;
    this.activeSeconds = 0;
    this.lastRepAt = 0;
    this.idleFrameCounter = 0;
    this.lastImuTimestampMs = null;
    this.filteredAccelMs2 = 0;
    this.repVelocitySamples = [];
    this.repStartSeconds = 0;
    this.kalman.reset();
    return this.snapshot();
  }

  snapshot(): TrackerSnapshot {
    return {
      reps: [...this.repsValue],
      currentVelocity: this.velocityValue,
      displacement: this.displacementValue,
      phase: this.phaseValue,
      centroid: this.centroidValue,
      trajectory: [...this.trajectoryValue],
      completedSet: this.completedSetValue,
    };
  }
}
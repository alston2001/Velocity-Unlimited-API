import { scrubFrameBuffer } from '@/src/lib/security';

export type CalibrationTarget = 'plate' | 'sleeve' | 'shaft';

export type GravityVector = {
  x: number;
  y: number;
  z: number;
};

export type Keypoint = {
  x: number;
  y: number;
  score: number;
};

export type DisplacementVector = {
  x: number;
  y: number;
  displacementY: number;
  score: number;
};

export interface VBTState {
  velocity: number;
  position: number;
  isCalibrated: boolean;
  tiltAngleDeg: number;
}

const TARGET_DIAMETERS_M: Record<CalibrationTarget, number> = {
  plate: 0.45,
  sleeve: 0.05,
  shaft: 0.028,
};

const DEFAULT_DT = 1 / 60;
const GRAVITY = 9.81;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function grayscaleAt(
  rgba: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
) {
  const offset = (y * width + x) * 4;
  return (
    rgba[offset]! * 0.299 +
    rgba[offset + 1]! * 0.587 +
    rgba[offset + 2]! * 0.114
  );
}

/**
 * Finds Shi-Tomasi/FAST-like high contrast corners on a regular image grid.
 * The routine intentionally uses only typed arrays and scalar operations so it
 * can be moved to a frame processor without adding a native CV dependency.
 */
export function detectCornerKeypoints(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  gridSize = 16,
  threshold = 18,
): Keypoint[] {
  const points: Keypoint[] = [];
  if (width < 5 || height < 5 || rgba.length < width * height * 4) {
    scrubFrameBuffer(rgba);
    return points;
  }

  for (let gy = 2; gy < height - 2; gy += gridSize) {
    for (let gx = 2; gx < width - 2; gx += gridSize) {
      let bestScore = threshold;
      let bestX = gx;
      let bestY = gy;

      for (let y = gy; y < Math.min(gy + gridSize, height - 2); y += 2) {
        for (let x = gx; x < Math.min(gx + gridSize, width - 2); x += 2) {
          const dx =
            grayscaleAt(rgba, width, x + 1, y) -
            grayscaleAt(rgba, width, x - 1, y);
          const dy =
            grayscaleAt(rgba, width, x, y + 1) -
            grayscaleAt(rgba, width, x, y - 1);
          const cross =
            Math.abs(
              grayscaleAt(rgba, width, x + 1, y + 1) -
                grayscaleAt(rgba, width, x - 1, y - 1),
            ) +
            Math.abs(
              grayscaleAt(rgba, width, x - 1, y + 1) -
                grayscaleAt(rgba, width, x + 1, y - 1),
            );
          const score = Math.min(
            Math.sqrt(dx * dx + dy * dy),
            cross * 0.5 + Math.abs(dx - dy) * 0.25,
          );
          if (score > bestScore) {
            bestScore = score;
            bestX = x;
            bestY = y;
          }
        }
      }

      if (bestScore > threshold) {
        points.push({ x: bestX, y: bestY, score: bestScore });
      }
    }
  }

  scrubFrameBuffer(rgba);
  return points;
}

function patchCorrelation(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  yA: number,
  yB: number,
  radius: number,
) {
  let sumA = 0;
  let sumB = 0;
  let count = 0;
  for (let py = -radius; py <= radius; py++) {
    for (let px = -radius; px <= radius; px++) {
      const ax = x + px;
      const ay = yA + py;
      const bx = x + px;
      const by = yB + py;
      if (
        ax < 0 ||
        ax >= width ||
        bx < 0 ||
        bx >= width ||
        ay < 0 ||
        ay >= height ||
        by < 0 ||
        by >= height
      ) {
        continue;
      }
      sumA += grayscaleAt(previous, width, ax, ay);
      sumB += grayscaleAt(current, width, bx, by);
      count++;
    }
  }
  if (count < 9) return -1;

  const meanA = sumA / count;
  const meanB = sumB / count;
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let py = -radius; py <= radius; py++) {
    for (let px = -radius; px <= radius; px++) {
      const ax = x + px;
      const ay = yA + py;
      const bx = x + px;
      const by = yB + py;
      if (
        ax < 0 ||
        ax >= width ||
        bx < 0 ||
        bx >= width ||
        ay < 0 ||
        ay >= height ||
        by < 0 ||
        by >= height
      ) {
        continue;
      }
      const a = grayscaleAt(previous, width, ax, ay) - meanA;
      const b = grayscaleAt(current, width, bx, by) - meanB;
      numerator += a * b;
      varianceA += a * a;
      varianceB += b * b;
    }
  }
  return numerator / Math.sqrt(varianceA * varianceB + 1e-6);
}

/**
 * Tracks vertical motion using zero-normalized cross-correlation (ZNCC).
 */
export function trackVerticalDisplacement(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
  width: number,
  height: number,
  keypoints: Keypoint[],
  searchRadius = 18,
  patchRadius = 3,
): DisplacementVector[] {
  const vectors: DisplacementVector[] = [];
  for (const point of keypoints) {
    let bestOffset = 0;
    let bestScore = -1;
    for (let offset = -searchRadius; offset <= searchRadius; offset++) {
      const score = patchCorrelation(
        previous,
        current,
        width,
        height,
        Math.round(point.x),
        Math.round(point.y),
        Math.round(point.y + offset),
        patchRadius,
      );
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    if (bestScore > 0.25) {
      vectors.push({
        x: point.x,
        y: point.y,
        displacementY: bestOffset,
        score: bestScore,
      });
    }
  }
  scrubFrameBuffer(previous);
  scrubFrameBuffer(current);
  return vectors;
}

/**
 * Rejects spatially inconsistent motion vectors using a 2.5 MAD fence.
 */
export function rejectSpatialOutliers(
  vectors: DisplacementVector[],
  madMultiplier = 2.5,
) {
  if (vectors.length < 3) return vectors;
  const displacements = vectors.map((vector) => vector.displacementY);
  const center = median(displacements);
  const mad = median(displacements.map((value) => Math.abs(value - center)));
  if (mad < 0.0001) {
    return vectors.filter(
      (vector) => Math.abs(vector.displacementY - center) < 1,
    );
  }
  return vectors.filter(
    (vector) =>
      Math.abs(vector.displacementY - center) <= madMultiplier * mad,
  );
}

export function estimateVerticalDisplacement(vectors: DisplacementVector[]) {
  return median(rejectSpatialOutliers(vectors).map((vector) => vector.displacementY));
}

export class VBTTracker {
  private metersPerPixel = TARGET_DIAMETERS_M.plate / 300;
  private calibrated = false;
  private targetType: CalibrationTarget = 'plate';
  private tiltAngleRad = 0;
  private lastGravity: GravityVector = { x: 0, y: 0, z: GRAVITY };

  // State vector x = [position (m), velocity (m/s)]ᵀ.
  private x: [number, number] = [0, 0];
  private P: [[number, number], [number, number]] = [
    [0.1, 0],
    [0, 0.1],
  ];
  private cumVisualPos = 0;
  private sigmaA = 0.35;
  private sigmaVisual = 0.003;
  private staticTime = 0;
  private accelerationWindow: number[] = [];

  public calibrateScale(
    observedPx: number,
    targetType: CalibrationTarget = 'plate',
    gravity = this.lastGravity,
  ) {
    if (!Number.isFinite(observedPx) || observedPx <= 2) return false;
    this.targetType = targetType;
    this.setGravity(gravity);
    const rectifiedPx = observedPx * Math.cos(this.tiltAngleRad);
    if (rectifiedPx <= 2) return false;
    this.metersPerPixel = TARGET_DIAMETERS_M[targetType] / rectifiedPx;
    this.calibrated = true;
    return true;
  }

  public setGravity(gravity: GravityVector) {
    this.lastGravity = gravity;
    const magnitude = Math.sqrt(
      gravity.x ** 2 + gravity.y ** 2 + gravity.z ** 2,
    );
    if (magnitude > 0.001) {
      this.tiltAngleRad = Math.asin(clamp(gravity.y / magnitude, -1, 1));
    }
  }

  public get tiltAngleDeg() {
    return (this.tiltAngleRad * 180) / Math.PI;
  }

  public get calibrationTarget() {
    return this.targetType;
  }

  public reset() {
    this.x = [0, 0];
    this.P = [
      [0.1, 0],
      [0, 0.1],
    ];
    this.cumVisualPos = 0;
    this.staticTime = 0;
    this.accelerationWindow = [];
  }

  public getState(): VBTState {
    return {
      velocity: this.x[1],
      position: this.x[0],
      isCalibrated: this.calibrated,
      tiltAngleDeg: this.tiltAngleDeg,
    };
  }

  public processFrame(
    deltaYPixels: number,
    accelY: number,
    dt = DEFAULT_DT,
    gravity?: GravityVector,
  ): VBTState {
    const safeDt = dt > 0 ? dt : DEFAULT_DT;
    if (gravity) this.setGravity(gravity);
    const rectifiedDeltaM =
      -deltaYPixels * this.metersPerPixel * Math.cos(this.tiltAngleRad);
    this.cumVisualPos += rectifiedDeltaM;

    const dt2 = safeDt ** 2;
    const dt3 = safeDt ** 3;
    const dt4 = safeDt ** 4;
    const xPred0 = this.x[0] + safeDt * this.x[1] + 0.5 * dt2 * accelY;
    const xPred1 = this.x[1] + safeDt * accelY;
    const q = this.sigmaA ** 2;
    const q00 = q * 0.25 * dt4;
    const q01 = q * 0.5 * dt3;
    const q11 = q * dt2;
    const p00 =
      this.P[0][0] +
      safeDt * (this.P[1][0] + this.P[0][1]) +
      dt2 * this.P[1][1] +
      q00;
    const p01 = this.P[0][1] + safeDt * this.P[1][1] + q01;
    const p10 = this.P[1][0] + safeDt * this.P[1][1] + q01;
    const p11 = this.P[1][1] + q11;

    const accelerationVariance = this.updateAccelerationVariance(accelY);
    if (accelerationVariance < 0.05) this.staticTime += safeDt;
    else this.staticTime = 0;

    // Dynamic R makes fast concentric bursts rely more on IMU prediction.
    const dynamicScale = Math.exp(Math.max(0, Math.abs(xPred1) - 0.8) * 2);
    const measurementVariance = this.sigmaVisual ** 2 * dynamicScale;
    const residual = this.cumVisualPos - xPred0;
    const gated = Math.abs(residual) > 0.08;

    if (!gated) {
      const innovationVariance = p00 + measurementVariance;
      const k0 = p00 / innovationVariance;
      const k1 = p10 / innovationVariance;
      this.x[0] = xPred0 + k0 * residual;
      this.x[1] = xPred1 + k1 * residual;
      this.P[0][0] = (1 - k0) * p00;
      this.P[0][1] = (1 - k0) * p01;
      this.P[1][0] = p10 - k1 * p00;
      this.P[1][1] = p11 - k1 * p01;
    } else {
      this.x = [xPred0, xPred1];
      this.P = [
        [p00, p01],
        [p10, p11],
      ];
    }

    // Static pause for >200 ms: eliminate integration drift with a ZUPT.
    if (this.staticTime > 0.2) {
      this.x[1] = 0;
      this.P[1][0] = 0;
      this.P[0][1] = 0;
    }

    return this.getState();
  }

  private updateAccelerationVariance(accelY: number) {
    this.accelerationWindow.push(accelY);
    if (this.accelerationWindow.length > 15) this.accelerationWindow.shift();
    if (this.accelerationWindow.length < 3) return Number.POSITIVE_INFINITY;
    const mean =
      this.accelerationWindow.reduce((sum, value) => sum + value, 0) /
      this.accelerationWindow.length;
    return (
      this.accelerationWindow.reduce(
        (sum, value) => sum + (value - mean) ** 2,
        0,
      ) / this.accelerationWindow.length
    );
  }
}
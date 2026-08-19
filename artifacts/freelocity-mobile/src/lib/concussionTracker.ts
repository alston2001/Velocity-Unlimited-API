export type EyeRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PupilAnalysis = {
  leftDiameterPx: number;
  rightDiameterPx: number;
  anisocoriaPercent: number;
  pupilScore: number;
  bilateralHyperDilation: boolean;
};

export type BalanceSample = {
  x: number;
  y: number;
  z: number;
};

export type BalanceResult = {
  swayRms: number;
  balanceScore: number;
  sampleCount: number;
  durationSec: number;
};

export type RiskTier = 'LOW' | 'MODERATE' | 'HIGH';

export type ConcussionAssessment = {
  pupil: PupilAnalysis | null;
  balance: BalanceResult | null;
  correctAnswers: number;
  cognitivePenalty: number;
  totalScore: number;
  riskTier: RiskTier;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function grayscale(
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
 * Detects a dark pupil blob and its edge gradients in a supplied eye crop.
 * Camera frame processors can pass their RGBA buffer directly to this routine.
 */
export function detectPupilDiameter(
  rgba: Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  region: EyeRegion,
): number {
  const x0 = clamp(Math.floor(region.x), 1, frameWidth - 2);
  const y0 = clamp(Math.floor(region.y), 1, frameHeight - 2);
  const x1 = clamp(Math.ceil(region.x + region.width), x0 + 2, frameWidth - 1);
  const y1 = clamp(Math.ceil(region.y + region.height), y0 + 2, frameHeight - 1);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  const intensities = new Float32Array(cropWidth * cropHeight);

  let mean = 0;
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const value = grayscale(rgba, frameWidth, x0 + x, y0 + y);
      intensities[y * cropWidth + x] = value;
      mean += value;
    }
  }
  mean /= intensities.length;
  const threshold = mean * 0.72;
  let minX = cropWidth;
  let minY = cropHeight;
  let maxX = -1;
  let maxY = -1;
  let edgeStrength = 0;

  for (let y = 1; y < cropHeight - 1; y++) {
    for (let x = 1; x < cropWidth - 1; x++) {
      const value = intensities[y * cropWidth + x]!;
      if (value < threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      const gx =
        intensities[y * cropWidth + x + 1]! -
        intensities[y * cropWidth + x - 1]!;
      const gy =
        intensities[(y + 1) * cropWidth + x]! -
        intensities[(y - 1) * cropWidth + x]!;
      edgeStrength += Math.sqrt(gx * gx + gy * gy);
    }
  }

  // A valid dark blob must have a measurable gradient boundary. For an
  // aligned eye crop, this also prevents a solid shadow from being a pupil.
  if (
    maxX <= minX ||
    maxY <= minY ||
    edgeStrength / intensities.length < 2
  ) {
    return Math.max(1, Math.min(cropWidth, cropHeight) * 0.18);
  }
  return Math.max(1, ((maxX - minX + 1) + (maxY - minY + 1)) / 2);
}

export function analyzePupils(
  rgba: Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  leftEye: EyeRegion,
  rightEye: EyeRegion,
): PupilAnalysis {
  const leftDiameterPx = detectPupilDiameter(
    rgba,
    frameWidth,
    frameHeight,
    leftEye,
  );
  const rightDiameterPx = detectPupilDiameter(
    rgba,
    frameWidth,
    frameHeight,
    rightEye,
  );
  const largest = Math.max(leftDiameterPx, rightDiameterPx, 1);
  const anisocoriaPercent =
    (Math.abs(leftDiameterPx - rightDiameterPx) / largest) * 100;
  const leftRelative = leftDiameterPx / Math.min(leftEye.width, leftEye.height);
  const rightRelative =
    rightDiameterPx / Math.min(rightEye.width, rightEye.height);
  const bilateralHyperDilation = leftRelative > 0.45 && rightRelative > 0.45;
  const anisocoriaPenalty =
    anisocoriaPercent > 10 ? clamp((anisocoriaPercent - 10) * 1.8, 0, 25) : 0;
  const dilationPenalty = bilateralHyperDilation ? 10 : 0;

  return {
    leftDiameterPx,
    rightDiameterPx,
    anisocoriaPercent,
    pupilScore: clamp(anisocoriaPenalty + dilationPenalty, 0, 35),
    bilateralHyperDilation,
  };
}

export function computeSwayRms(samples: BalanceSample[]) {
  if (samples.length === 0) return 0;
  const sumSquares = samples.reduce(
    (sum, sample) => sum + sample.x ** 2 + sample.y ** 2 + sample.z ** 2,
    0,
  );
  return Math.sqrt(sumSquares / samples.length);
}

export function scoreBalance(swayRms: number) {
  if (swayRms <= 0.4) return 0;
  return clamp(((swayRms - 0.4) / 0.8) * 35, 0, 35);
}

export function finishBalance(
  samples: BalanceSample[],
  durationSec = 10,
): BalanceResult {
  const swayRms = computeSwayRms(samples);
  return {
    swayRms,
    balanceScore: scoreBalance(swayRms),
    sampleCount: samples.length,
    durationSec,
  };
}

export function cognitivePenalty(correctAnswers: number) {
  return clamp(30 * (1 - clamp(correctAnswers, 0, 10) / 10), 0, 30);
}

export function getRiskTier(totalScore: number): RiskTier {
  if (totalScore <= 25) return 'LOW';
  if (totalScore <= 55) return 'MODERATE';
  return 'HIGH';
}

export function buildAssessment(
  pupil: PupilAnalysis | null,
  balance: BalanceResult | null,
  correctAnswers: number,
): ConcussionAssessment {
  const pupilScore = pupil?.pupilScore ?? 0;
  const balanceScore = balance?.balanceScore ?? 0;
  const penalty = cognitivePenalty(correctAnswers);
  const totalScore = clamp(pupilScore + balanceScore + penalty, 0, 100);
  return {
    pupil,
    balance,
    correctAnswers,
    cognitivePenalty: penalty,
    totalScore,
    riskTier: getRiskTier(totalScore),
  };
}
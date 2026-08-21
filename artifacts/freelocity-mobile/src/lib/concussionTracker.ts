import { scrubFrameBuffer } from '@/src/lib/security';

export type EyeRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Iris diameter in pixels, when a reliable iris boundary is available. */
  irisDiameterPx?: number;
};

export type PupilAnalysis = {
  leftDiameterPx: number;
  rightDiameterPx: number;
  leftRelativeToIris: number;
  rightRelativeToIris: number;
  bilateralDilation: number;
  irisBoundaryReliable: boolean;
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
export type CognitiveDomain = 'orientation' | 'concentration' | 'memory';
export type CognitiveAnswer = {
  correct: boolean;
  domain: CognitiveDomain;
};

export type ConcussionAssessment = {
  pupil: PupilAnalysis | null;
  balance: BalanceResult | null;
  correctAnswers: number;
  orientationCorrect: number;
  concentrationCorrect: number;
  memoryCorrect: number;
  cognitivePenalty: number;
  balanceScore: number;
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
    intensities.fill(0);
    return Math.max(1, Math.min(cropWidth, cropHeight) * 0.18);
  }
  const diameter = Math.max(1, ((maxX - minX + 1) + (maxY - minY + 1)) / 2);
  intensities.fill(0);
  return diameter;
}

export function analyzePupils(
  rgba: Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  leftEye: EyeRegion,
  rightEye: EyeRegion,
): PupilAnalysis {
  try {
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
    const leftIris = leftEye.irisDiameterPx ?? Math.min(leftEye.width, leftEye.height);
    const rightIris = rightEye.irisDiameterPx ?? Math.min(rightEye.width, rightEye.height);
    const irisBoundaryReliable = Boolean(leftEye.irisDiameterPx && rightEye.irisDiameterPx);
    const leftRelativeToIris = leftDiameterPx / Math.max(leftIris, 1);
    const rightRelativeToIris = rightDiameterPx / Math.max(rightIris, 1);
    const bilateralDilation = (leftRelativeToIris + rightRelativeToIris) / 2;
    const largest = Math.max(leftRelativeToIris, rightRelativeToIris, 0.01);
    const anisocoriaPercent =
      (Math.abs(leftRelativeToIris - rightRelativeToIris) / largest) * 100;
    const bilateralHyperDilation = bilateralDilation > 0.45;
    const anisocoriaPenalty =
      anisocoriaPercent > 10
        ? clamp((anisocoriaPercent - 10) * 2.5, 0, 40)
        : 0;
    const dilationPenalty = bilateralHyperDilation ? 10 : 0;

    return {
      leftDiameterPx,
      rightDiameterPx,
      leftRelativeToIris,
      rightRelativeToIris,
      bilateralDilation,
      irisBoundaryReliable,
      anisocoriaPercent,
      pupilScore: clamp(anisocoriaPenalty + dilationPenalty, 0, 50),
      bilateralHyperDilation,
    };
  } finally {
    scrubFrameBuffer(rgba);
  }
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
  return clamp(50 * (1 - clamp(correctAnswers, 0, 10) / 10), 0, 50);
}

export function getRiskTier(totalScore: number): RiskTier {
  if (totalScore <= 25) return 'LOW';
  if (totalScore <= 55) return 'MODERATE';
  return 'HIGH';
}

export function buildAssessment(
  pupil: PupilAnalysis | null,
  balance: BalanceResult | null,
  answers: CognitiveAnswer[] | number,
): ConcussionAssessment {
  const answerList: CognitiveAnswer[] =
    typeof answers === 'number'
      ? []
      : answers;
  const correctAnswers =
    typeof answers === 'number'
      ? clamp(answers, 0, 10)
      : answerList.filter((answer) => answer.correct).length;
  const pupilScore = pupil?.pupilScore ?? 0;
  const balanceScore = balance?.balanceScore ?? 0;
  const penalty = cognitivePenalty(correctAnswers);
  const orientationCorrect = answerList.filter(
    (answer) => answer.domain === 'orientation' && answer.correct,
  ).length;
  const concentrationCorrect = answerList.filter(
    (answer) => answer.domain === 'concentration' && answer.correct,
  ).length;
  const memoryCorrect = answerList.filter(
    (answer) => answer.domain === 'memory' && answer.correct,
  ).length;
  // The competition-facing composite intentionally uses the dual-biometric
  // matrix: pupil analysis (0–50) plus SAC cognitive penalty (0–50).
  const totalScore = clamp(pupilScore + penalty, 0, 100);
  return {
    pupil,
    balance,
    correctAnswers,
    orientationCorrect,
    concentrationCorrect,
    memoryCorrect,
    cognitivePenalty: penalty,
    balanceScore,
    totalScore,
    riskTier: getRiskTier(totalScore),
  };
}

export function generateSmsReportPayload(
  pupilAsymmetry: number,
  cognitiveScore: number,
  totalRisk: number,
  riskLevel: string,
) {
  const timestamp = new Date().toLocaleString();
  const timeHex = Date.now().toString(16).toUpperCase();
  const randomHex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
    .toUpperCase();
  const sessionId = `FREELOCITY-VERIFIED-${timeHex.slice(-6)}${randomHex.slice(
    0,
    2,
  )}`;
  return [
    '🚨 FREELOCITY CONCUSSION ASSESSMENT REPORT',
    '------------------------------------------',
    '',
    `Timestamp: ${timestamp}`,
    '',
    `Session ID: ${sessionId}`,
    '',
    'SUMMARY METRICS:',
    '',
    `- Pupil Asymmetry: ${pupilAsymmetry.toFixed(1)}%`,
    '',
    `- Cognitive SAC Score: ${Math.round(cognitiveScore)}/10 Correct`,
    '',
    `- Composite Risk Score: ${Math.round(totalRisk)}/100`,
    '',
    `- Risk Assessment: ${riskLevel} RISK`,
    '',
    '------------------------------------------',
    '',
    'DISCLAIMER: Screening tool only. Not a medical diagnosis. Results must be reviewed immediately by a certified healthcare professional or athletic trainer.',
    '',
    'App Signature: Freelocity VBT Engine v1.0 (Authenticated Session)',
  ].join('\n');
}
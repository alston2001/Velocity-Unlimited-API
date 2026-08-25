import type { RepMetric } from './vbtTracker';

export type ExerciseMeasurementMode = 'SQUAT_CV' | 'LAT_PULLDOWN_IMU';

export type CvFramePoint = {
  timestamp: number;
  displacementM: number;
  tracked: boolean;
};

export type CvRepBounds = {
  startIndex: number;
  endIndex: number;
};

export const DEFAULT_PLATE_DIAMETER_MM = 450;
export const LOW_CONFIDENCE_LOST_FRAME_RATIO = 0.15;

export function measurementModeForExercise(exerciseName: string): ExerciseMeasurementMode {
  return exerciseName.trim().toLocaleLowerCase().replace(/\s+/g, ' ') === 'squat'
    ? 'SQUAT_CV'
    : 'LAT_PULLDOWN_IMU';
}

export function getCvTrackingConfidence(points: CvFramePoint[]): number {
  if (points.length === 0) return 0;
  return points.filter((point) => point.tracked).length / points.length;
}

export function needsManualCvReview(points: CvFramePoint[], reps: RepMetric[]): boolean {
  return getCvTrackingConfidence(points) < 1 - LOW_CONFIDENCE_LOST_FRAME_RATIO || reps.length === 0;
}

export function trimRackingNoise(points: CvFramePoint[], stopTimestamp: number): CvFramePoint[] {
  const recordingPoints = points.filter((point) => point.timestamp <= stopTimestamp);
  if (recordingPoints.length < 4) return recordingPoints;
  const tailStart = Math.max(0, recordingPoints.length - 4);
  const tail = recordingPoints.slice(tailStart);
  const tailStep = tail.slice(1).reduce(
    (sum, point, index) => sum + Math.abs(point.displacementM - tail[index]!.displacementM),
    0,
  ) / Math.max(1, tail.length - 1);
  return tailStep > 0.12 ? recordingPoints.slice(0, tailStart) : recordingPoints;
}

export function deriveCvRepMetrics(points: CvFramePoint[], bounds: CvRepBounds[]): RepMetric[] {
  return bounds.flatMap((bound, index) => {
    const range = points.slice(bound.startIndex, bound.endIndex + 1).filter((point) => point.tracked);
    if (range.length < 2) return [];
    const velocities = range.slice(1).map((point, pointIndex) => {
      const previous = range[pointIndex]!;
      const deltaSeconds = (point.timestamp - previous.timestamp) / 1000;
      return deltaSeconds > 0 ? Math.abs((point.displacementM - previous.displacementM) / deltaSeconds) : 0;
    }).filter((value) => Number.isFinite(value) && value > 0);
    if (velocities.length === 0) return [];
    const duration = (range[range.length - 1]!.timestamp - range[0]!.timestamp) / 1000;
    return [{
      repNumber: index + 1,
      repTimeSec: Math.max(0, duration),
      meanVelocity: velocities.reduce((sum, value) => sum + value, 0) / velocities.length,
      peakVelocity: Math.max(...velocities),
      measurementStatus: 'MEASURED' as const,
    }];
  });
}

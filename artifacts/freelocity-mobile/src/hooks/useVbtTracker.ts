import { useCallback, useRef, useState } from 'react';
import {
  VBTTracker,
  type CalibrationTarget,
  type GravityVector,
  type VBTState,
} from '@/src/lib/vbtTracker';

export function useVbtTracker() {
  const tracker = useRef<VBTTracker | null>(null);
  if (tracker.current === null) tracker.current = new VBTTracker();

  const [state, setState] = useState<VBTState>({
    velocity: 0,
    position: 0,
    isCalibrated: false,
    tiltAngleDeg: 0,
  });

  const update = useCallback(
    (
      deltaYPixels: number,
      accelY: number,
      dt: number = 0.0166,
      gravity?: GravityVector,
    ) => {
      const next = tracker.current!.processFrame(
        deltaYPixels,
        accelY,
        dt,
        gravity,
      );
      setState(next);
      return next;
    },
    [],
  );

  const resetTracker = useCallback(() => {
    tracker.current!.reset();
    setState(tracker.current!.getState());
  }, []);

  const calibrate = useCallback(
    (observedPx: number, targetType: CalibrationTarget = 'plate') => {
      const calibrated = tracker.current!.calibrateScale(
        observedPx,
        targetType,
      );
      setState(tracker.current!.getState());
      return calibrated;
    },
    [],
  );

  const setGravity = useCallback((gravity: GravityVector) => {
    tracker.current!.setGravity(gravity);
    setState(tracker.current!.getState());
  }, []);

  const currentState = state;

  return {
    velocity: currentState.velocity,
    position: currentState.position,
    isCalibrated: currentState.isCalibrated,
    tiltAngleDeg: currentState.tiltAngleDeg,
    update,
    resetTracker,
    calibrate,
    setGravity,
  };
}
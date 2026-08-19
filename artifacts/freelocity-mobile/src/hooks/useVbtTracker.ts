import { useCallback, useRef, useState } from 'react';
import { VBTTracker, type VBTState } from '@/src/lib/vbtTracker';

export function useVbtTracker() {
  const tracker = useRef<VBTTracker | null>(null);
  if (tracker.current === null) tracker.current = new VBTTracker();

  const [state, setState] = useState<VBTState>({
    velocity: 0,
    position: 0,
    isCalibrated: false,
  });

  const update = useCallback(
    (deltaYPixels: number, accelY: number, dt: number = 0.0166) => {
      const next = tracker.current!.processFrame(deltaYPixels, accelY, dt);
      setState(next);
      return next;
    },
    [],
  );

  const resetTracker = useCallback(() => {
    tracker.current!.reset();
    setState({
      velocity: 0,
      position: 0,
      isCalibrated: false,
    });
  }, []);

  const calibrate = useCallback((plateHeightPx: number) => {
    const calibrated = tracker.current!.calibrateScale(plateHeightPx);
    setState((current) => ({ ...current, isCalibrated: calibrated }));
    return calibrated;
  }, []);

  return {
    velocity: state.velocity,
    position: state.position,
    isCalibrated: state.isCalibrated,
    update,
    resetTracker,
    calibrate,
  };
}
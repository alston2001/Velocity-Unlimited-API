import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExerciseTracker,
  type Point,
  type RepMetric,
  type SetSummary,
  type TrackerMode,
  type TrackerPhase,
} from '@/src/lib/vbtTracker';

export function useVbtTracker(mode: TrackerMode) {
  const engineRef = useRef<ExerciseTracker | null>(null);
  if (engineRef.current === null || engineRef.current.mode !== mode) {
    engineRef.current = new ExerciseTracker(mode);
  }
  const [snapshot, setSnapshot] = useState(engineRef.current.snapshot());

  useEffect(() => {
    setSnapshot(engineRef.current!.reset());
  }, [mode]);

  const updateImu = useCallback((accelY: number, dt: number) => {
    const next = engineRef.current!.updateImu(accelY, dt);
    setSnapshot(next);
    return next;
  }, []);

  const processFrame = useCallback(
    (
      rgba: Uint8ClampedArray | null,
      width: number,
      height: number,
      dt: number,
    ) => {
      const next = engineRef.current!.processFrame(rgba, width, height, dt);
      setSnapshot(next);
      return next;
    },
    [],
  );

  const manualIncrementRep = useCallback(() => {
    const next = engineRef.current!.manualIncrementRep();
    setSnapshot(next);
    return next;
  }, []);

  const resetTracker = useCallback(() => {
    const next = engineRef.current!.reset();
    setSnapshot(next);
    return next;
  }, []);

  const calibratePlate = useCallback((observedPx: number) => {
    return engineRef.current!.calibratePlate(observedPx);
  }, []);

  const setCustomReference = useCallback(
    (referenceMeters: number, observedPx: number) => {
      return engineRef.current!.setCustomReference(referenceMeters, observedPx);
    },
    [],
  );

  return {
    reps: snapshot.reps as RepMetric[],
    currentVelocity: snapshot.currentVelocity,
    displacement: snapshot.displacement,
    phase: snapshot.phase as TrackerPhase,
    centroid: snapshot.centroid as Point | null,
    trajectory: snapshot.trajectory as Point[],
    completedSet: snapshot.completedSet as SetSummary | null,
    updateImu,
    processFrame,
    manualIncrementRep,
    resetTracker,
    calibratePlate,
    setCustomReference,
  };
}
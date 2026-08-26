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
  const snapshotRef = useRef(snapshot);
  const lastPublishedAt = useRef(0);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSnapshot = useRef<typeof snapshot | null>(null);

  const publishSnapshot = useCallback((next: typeof snapshot, immediate = false) => {
    snapshotRef.current = next;
    const now = Date.now();
    if (immediate || now - lastPublishedAt.current >= 100) {
      if (publishTimer.current) {
        clearTimeout(publishTimer.current);
        publishTimer.current = null;
      }
      pendingSnapshot.current = null;
      lastPublishedAt.current = now;
      setSnapshot(next);
      return;
    }
    pendingSnapshot.current = next;
    if (!publishTimer.current) {
      publishTimer.current = setTimeout(() => {
        publishTimer.current = null;
        const pending = pendingSnapshot.current;
        if (!pending) return;
        pendingSnapshot.current = null;
        lastPublishedAt.current = Date.now();
        setSnapshot(pending);
      }, 100 - (now - lastPublishedAt.current));
    }
  }, []);

  useEffect(() => {
    publishSnapshot(engineRef.current!.reset(), true);
  }, [mode, publishSnapshot]);

  useEffect(() => () => {
    if (publishTimer.current) clearTimeout(publishTimer.current);
  }, []);

  const updateImu = useCallback((accelMs2: number, timestampMs: number) => {
    const next = engineRef.current!.updateImu(accelMs2, timestampMs);
    publishSnapshot(next);
    return next;
  }, [publishSnapshot]);

  const calibrateImu = useCallback((restSamplesMs2: number[]) => {
    const calibrated = engineRef.current!.calibrateImu(restSamplesMs2);
    publishSnapshot(engineRef.current!.snapshot(), true);
    return calibrated;
  }, [publishSnapshot]);

  const processFrame = useCallback(
    (
      rgba: Uint8ClampedArray | null,
      width: number,
      height: number,
      dt: number,
    ) => {
      const next = engineRef.current!.processFrame(rgba, width, height, dt);
      publishSnapshot(next);
      return next;
    },
    [publishSnapshot],
  );

  const manualIncrementRep = useCallback(() => {
    const next = engineRef.current!.manualIncrementRep();
    publishSnapshot(next, true);
    return next;
  }, [publishSnapshot]);

  const resetTracker = useCallback(() => {
    const next = engineRef.current!.reset();
    publishSnapshot(next, true);
    return next;
  }, [publishSnapshot]);

  const stopSet = useCallback(() => {
    const next = engineRef.current!.stopSet();
    publishSnapshot(next, true);
    return next;
  }, [publishSnapshot]);

  const calibratePlate = useCallback((observedPx: number) => {
    const calibrated = engineRef.current!.calibratePlate(observedPx);
    publishSnapshot(engineRef.current!.snapshot(), true);
    return calibrated;
  }, [publishSnapshot]);

  const calibratePlateFromFrame = useCallback(
    (rgba: Uint8ClampedArray, width: number, height: number, referenceMeters: number) => {
      const observation = engineRef.current!.calibratePlateFromFrame(
        rgba,
        width,
        height,
        referenceMeters,
      );
      publishSnapshot(engineRef.current!.snapshot(), true);
      return observation;
    },
    [publishSnapshot],
  );

  const setCustomReference = useCallback(
    (referenceMeters: number, observedPx: number) => {
      return engineRef.current!.setCustomReference(referenceMeters, observedPx);
    },
    [],
  );

  return {
    reps: snapshot.reps as RepMetric[],
    currentVelocity: snapshot.currentVelocity,
    calibrated: engineRef.current.calibrated,
    displacement: snapshot.displacement,
    phase: snapshot.phase as TrackerPhase,
    centroid: snapshot.centroid as Point | null,
    trajectory: snapshot.trajectory as Point[],
    trackingConfidence: snapshot.trackingConfidence,
    calibrationConfidence: snapshot.calibrationConfidence,
    completedSet: snapshot.completedSet as SetSummary | null,
    updateImu,
    calibrateImu,
    processFrame,
    manualIncrementRep,
    resetTracker,
    stopSet,
    calibratePlate,
    calibratePlateFromFrame,
    setCustomReference,
  };
}
import { useCallback, useRef, useState } from 'react';

type TrackerState = {
  position: number;
  velocity: number;
};

type KalmanState = {
  position: number;
  velocity: number;
  p00: number;
  p01: number;
  p10: number;
  p11: number;
};

const INITIAL_STATE: KalmanState = {
  position: 0,
  velocity: 0,
  p00: 0.1,
  p01: 0,
  p10: 0,
  p11: 0.1,
};

const SIGMA_A = 0.35;

/**
 * Local 1D constant-acceleration Kalman tracker.
 *
 * The phone's accelerometer is the prediction input. The hook keeps the
 * filter state in refs so the listener can process samples at sensor rate
 * without waiting for React renders.
 */
export function useVbtTracker() {
  const filter = useRef<KalmanState>({ ...INITIAL_STATE });
  const [state, setState] = useState<TrackerState>({
    position: 0,
    velocity: 0,
  });

  const processFrame = useCallback((accelYMs2: number, dt: number) => {
    if (!Number.isFinite(accelYMs2) || !Number.isFinite(dt) || dt <= 0) return;

    const current = filter.current;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;

    // Predict: x = F x + B a
    const predictedPosition =
      current.position + current.velocity * dt + 0.5 * accelYMs2 * dt2;
    const predictedVelocity = current.velocity + accelYMs2 * dt;

    // Predict covariance: P = F P Fᵀ + Q
    const qScale = SIGMA_A * SIGMA_A;
    const q00 = qScale * 0.25 * dt4;
    const q01 = qScale * 0.5 * dt3;
    const q11 = qScale * dt2;
    const predictedP00 =
      current.p00 +
      dt * (current.p10 + current.p01) +
      dt2 * current.p11 +
      q00;
    const predictedP01 = current.p01 + dt * current.p11 + q01;
    const predictedP10 = current.p10 + dt * current.p11 + q01;
    const predictedP11 = current.p11 + q11;

    // There is no external visual measurement: the locally predicted state is
    // the fused output and remains ready for a future local camera measurement.
    filter.current = {
      position: predictedPosition,
      velocity: predictedVelocity,
      p00: predictedP00,
      p01: predictedP01,
      p10: predictedP10,
      p11: predictedP11,
    };
    setState({
      position: predictedPosition,
      velocity: predictedVelocity,
    });
  }, []);

  const reset = useCallback(() => {
    filter.current = { ...INITIAL_STATE };
    setState({ position: 0, velocity: 0 });
  }, []);

  return {
    position: state.position,
    velocity: state.velocity,
    processFrame,
    reset,
  };
}
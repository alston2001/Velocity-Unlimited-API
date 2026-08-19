export interface VBTState {
  velocity: number;
  position: number;
  isCalibrated: boolean;
}

export class VBTTracker {
  private plateDiameterM: number;
  private metersPerPixel: number;
  private calibrated = false;

  // State vector x = [position (m), velocity (m/s)]^T
  private x: [number, number] = [0, 0];

  // State Covariance Matrix P (2x2)
  private P: [[number, number], [number, number]] = [
    [0.1, 0.0],
    [0.0, 0.1],
  ];

  private cumVisualPos = 0;

  // Noise covariance tuning parameters
  private sigmaA = 0.35;
  private sigmaVis = 0.003;

  constructor(plateDiameterM: number = 0.45, defaultPlatePx: number = 300) {
    this.plateDiameterM = plateDiameterM;
    this.metersPerPixel = plateDiameterM / defaultPlatePx;
  }

  /**
   * Dynamic scale setup using plate bounding box pixel height.
   */
  public calibrateScale(plateHeightPx: number): boolean {
    if (plateHeightPx > 20) {
      this.metersPerPixel = this.plateDiameterM / plateHeightPx;
      this.calibrated = true;
      return true;
    }
    return false;
  }

  /**
   * Reset state vectors and covariance matrices between sets/reps.
   */
  public reset(): void {
    this.x = [0.0, 0.0];
    this.P = [
      [0.1, 0.0],
      [0.0, 0.1],
    ];
    this.cumVisualPos = 0.0;
  }

  /**
   * Core sensor-fusion execution step (1D Kalman filter).
   *
   * @param deltaYPixels Y-axis pixel movement from visual tracking/flow
   * @param accelY Gravity-compensated Y-axis acceleration from IMU (m/s²)
   * @param dt Time delta between frames in seconds
   */
  public processFrame(
    deltaYPixels: number,
    accelY: number,
    dt: number = 0.0166,
  ): VBTState {
    if (dt <= 0) dt = 0.0166;

    // Visual measurement update: visual downward = physical upward.
    const deltaYMeters = -deltaYPixels * this.metersPerPixel;
    this.cumVisualPos += deltaYMeters;

    // Kalman prediction driven by accelerometer control input.
    const dt2 = dt ** 2;
    const dt3 = dt ** 3;
    const dt4 = dt ** 4;
    const xPred0 = this.x[0] + dt * this.x[1] + 0.5 * dt2 * accelY;
    const xPred1 = this.x[1] + dt * accelY;

    // Discrete process noise Q.
    const qBase = this.sigmaA ** 2;
    const Q00 = qBase * 0.25 * dt4;
    const Q01 = qBase * 0.5 * dt3;
    const Q11 = qBase * dt2;

    // P_pred = F * P * Fᵀ + Q
    const P00 = this.P[0][0] + dt * (this.P[1][0] + this.P[0][1]) + dt2 * this.P[1][1] + Q00;
    const P01 = this.P[0][1] + dt * this.P[1][1] + Q01;
    const P10 = this.P[1][0] + dt * this.P[1][1] + Q01;
    const P11 = this.P[1][1] + Q11;

    // Kalman measurement correction driven by visual position.
    const yTilde = this.cumVisualPos - xPred0;
    const S = P00 + this.sigmaVis ** 2;
    const K0 = P00 / S;
    const K1 = P10 / S;

    this.x[0] = xPred0 + K0 * yTilde;
    this.x[1] = xPred1 + K1 * yTilde;

    this.P[0][0] = (1 - K0) * P00;
    this.P[0][1] = (1 - K0) * P01;
    this.P[1][0] = P10 - K1 * P00;
    this.P[1][1] = P11 - K1 * P01;

    return {
      velocity: this.x[1],
      position: this.x[0],
      isCalibrated: this.calibrated,
    };
  }
}
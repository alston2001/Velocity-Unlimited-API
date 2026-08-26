import { Accelerometer } from 'expo-sensors';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import jpeg from 'jpeg-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { analyzeSet, type SetAnalysisResult } from '@workspace/api-client-react';
import { useConcussionTracker } from '@/src/hooks/useConcussionTracker';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';
import { DEFAULT_PLATE_DIAMETER_MM, deriveCvRepMetrics, getCvTrackingConfidence, measurementModeForExercise, needsManualCvReview, trimRackingNoise, type CvFramePoint, type CvRepBounds } from '@/src/lib/exerciseMeasurement';
import { formatMassFromKg, fromCanonicalKg, getUnitConfig, toCanonicalKg, type UnitSystem } from '@/src/lib/units';
import type { SetSummary } from '@/src/lib/vbtTracker';

type Phase = 'SETUP' | 'CALIBRATE' | 'RECORD' | 'POST_REVIEW' | 'PROCESSING' | 'FEEDBACK' | 'RECOVERY';
type CalibrationState = 'IDLE' | 'CAPTURING' | 'READY' | 'FAILED';
const UNIT_STORAGE_KEY = 'freelocity.unit-system';
const REST_CALIBRATION_MS = 1000;
const IMU_INTERVAL_MS = 20;
const CV_SNAPSHOT_INTERVAL_MS = 200;

type DecodedCameraFrame = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
};

function decodeCameraFrame(base64: string): DecodedCameraFrame {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const cleanBase64 = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const byteLength = Math.floor(cleanBase64.length * 3 / 4) - (cleanBase64.endsWith('==') ? 2 : cleanBase64.endsWith('=') ? 1 : 0);
  const bytes = new Uint8Array(byteLength);
  let outputIndex = 0;
  for (let index = 0; index < cleanBase64.length; index += 4) {
    const a = alphabet.indexOf(cleanBase64[index]!);
    const b = alphabet.indexOf(cleanBase64[index + 1]!);
    const c = alphabet.indexOf(cleanBase64[index + 2]!);
    const d = alphabet.indexOf(cleanBase64[index + 3]!);
    bytes[outputIndex++] = (a << 2) | (b >> 4);
    if (outputIndex < byteLength) bytes[outputIndex++] = ((b & 15) << 4) | (c >> 2);
    if (outputIndex < byteLength) bytes[outputIndex++] = ((c & 3) << 6) | d;
  }
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const maxDimension = 320;
  const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
  const width = Math.max(8, Math.round(decoded.width * scale));
  const height = Math.max(8, Math.round(decoded.height * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(decoded.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(x / scale));
      const sourceOffset = (sourceY * decoded.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      rgba[targetOffset] = decoded.data[sourceOffset] ?? 0;
      rgba[targetOffset + 1] = decoded.data[sourceOffset + 1] ?? 0;
      rgba[targetOffset + 2] = decoded.data[sourceOffset + 2] ?? 0;
      rgba[targetOffset + 3] = decoded.data[sourceOffset + 3] ?? 255;
    }
  }
  return { rgba, width, height };
}

function Button({ label, onPress, disabled = false, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable testID={`button-${label.toLowerCase().replace(/\W+/g, '-')}`} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, { opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }]}><Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text></Pressable>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text>{note ? <Text style={styles.metricNote}>{note}</Text> : null}</View>;
}

function UnitToggle({ value, onChange }: { value: UnitSystem; onChange: (next: UnitSystem) => void }) {
  return <View style={styles.unitToggle}>{(['imperial', 'metric'] as const).map((unit) => <Pressable key={unit} testID={`unit-${unit}`} onPress={() => onChange(unit)} style={[styles.unit, value === unit && styles.unitSelected]}><Text style={[styles.unitText, value === unit && styles.unitTextSelected]}>{getUnitConfig(unit).label}</Text><Text style={[styles.caption, value === unit && styles.unitTextSelected]}>{getUnitConfig(unit).abbreviation}</Text></Pressable>)}</View>;
}

function Recovery({ onBack }: { onBack: () => void }) {
  const tracker = useConcussionTracker();
  const [consented, setConsented] = useState(false);
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>SEPARATE SAFETY CHECK</Text><Text style={styles.title}>Recovery check-in</Text>
    <Text style={styles.body}>This is a conservative screening aid, not a concussion diagnosis. Do not use it to clear someone to play.</Text>
    {!consented ? <View style={styles.card}><Text style={styles.cardTitle}>Before you begin</Text><Text style={styles.body}>Only continue if it is safe to do so. New, severe, or worsening symptoms need qualified medical guidance.</Text><Button label="I CONSENT · START CHECK" onPress={() => setConsented(true)} /></View> :
      <View style={styles.card}><Text style={styles.cardTitle}>Conservative check-in</Text><Text style={styles.body}>This separate screen remains independent from training readiness and set velocity.</Text><Button label="MARK BALANCE SAMPLE" onPress={() => { tracker.startBalance(); tracker.recordBalanceSample({ x: 0, y: 0, z: 0 }); tracker.completeBalance(10); }} /><Text style={styles.caption}>Do not use this result for diagnosis or return-to-play decisions.</Text></View>}
    <Button label="BACK TO SET FEEDBACK" secondary onPress={onBack} />
  </ScrollView>;
}

function Feedback({ exerciseName, unitSystem, weightKg, summary, result, error, onRestart, onRecovery }: {
  exerciseName: string; unitSystem: UnitSystem; weightKg: number; summary: SetSummary; result: SetAnalysisResult | null; error: string | null; onRestart: () => void; onRecovery: () => void;
}) {
  const measured = summary.measurementStatus === 'MEASURED';
  const source = measurementModeForExercise(exerciseName) === 'SQUAT_CV' ? 'COMPUTER VISION' : 'WEIGHT-STACK IMU';
  const serverOwnsRepTable = source === 'WEIGHT-STACK IMU' && result !== null;
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>SET FEEDBACK · {exerciseName.toUpperCase()}</Text><Text style={styles.title}>What changed today</Text>
    <View style={styles.source}><Text style={styles.sourceText}>{measured ? `${source} · MEASURED` : 'VELOCITY WITHHELD'}</Text><Text style={styles.body}>{measured ? `${source} velocity was calculated from this set's local measurement data.` : summary.unavailableReason ?? error ?? 'This capture did not produce a supportable velocity measurement.'}</Text></View>
    <View style={styles.grid}>
      <Metric label="LOAD" value={formatMassFromKg(weightKg, unitSystem)} />
      <Metric label="REPS" value={String(result?.actual_reps ?? summary.reps.length)} />
      <Metric label="MEAN VELOCITY" value={measured ? `${(result?.mean_velocity_ms ?? 0).toFixed(3)} m/s` : 'Unavailable'} />
      <Metric label="PEAK VELOCITY" value={measured ? `${(result?.peak_velocity_ms ?? summary.topSpeed).toFixed(3)} m/s` : 'Unavailable'} />
      <Metric label="VELOCITY LOSS" value={result?.velocity_loss_pct == null ? '—' : `${result.velocity_loss_pct.toFixed(1)}%`} />
      <Metric label="QUALITY" value={measured ? 'MEASURED' : 'WITHHELD'} note={measured ? `${result?.sample_count ?? summary.sampleCount ?? 0} samples` : 'no readiness or coaching'} />
    </View>
    <View style={styles.card}><Text style={styles.cardTitle}>Rep-by-rep velocity</Text>{serverOwnsRepTable ? result.rep_peaks_ms.map((peak, index) => <View style={styles.repRow} key={index}><Text style={styles.repName}>REP {index + 1}</Text><Text style={styles.repMetric}>Server-validated IMU peak</Text><Text style={styles.repMetric}>{peak.toFixed(3)} m/s peak</Text></View>) : summary.reps.length ? summary.reps.map((rep) => <View style={styles.repRow} key={rep.repNumber}><Text style={styles.repName}>REP {rep.repNumber}</Text><Text style={styles.repMetric}>{rep.repTimeSec.toFixed(2)} s</Text><Text style={styles.repMetric}>{rep.meanVelocity?.toFixed(3) ?? '—'} m/s mean</Text><Text style={styles.repMetric}>{rep.peakVelocity?.toFixed(3) ?? '—'} m/s peak</Text></View>) : <Text style={styles.body}>No complete, reliable repetitions were available.</Text>}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>Readiness · load matched</Text><Text style={styles.readiness}>{result?.cns_readiness_score == null ? 'Building baseline' : `${result.cns_readiness_score}/100`}</Text><Text style={styles.body}>{result?.motor_readiness_level ?? 'Unavailable without a valid measured set'} · {result?.velocity_trend ?? 'Insufficient data'}</Text></View>
    <View style={styles.card}><Text style={styles.cardTitle}>Historical profile</Text><Text style={styles.body}>{result?.historical_comparison ?? 'Historical comparison is available after a valid measured set is saved.'}</Text></View>
    <View style={styles.card}><Text style={styles.cardTitle}>AI coach · evidence grounded</Text>{result?.deterministic_status ? <Text style={styles.success}>DATA STATUS · {result.deterministic_status.replaceAll('_', ' ')}</Text> : null}<Text style={styles.body}>{result?.ai_feedback ?? error ?? 'Coaching was withheld because this capture was not a valid measurement.'}</Text><Text style={styles.caption}>Performance guidance only. It does not diagnose injury, fatigue, or recovery status.</Text></View>
    <Button label="START SEPARATE RECOVERY CHECK-IN" secondary onPress={onRecovery} /><Button label="START ANOTHER SET" onPress={onRestart} />
  </ScrollView>;
}

export default function MotionTrackerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('SETUP');
  const [exerciseName, setExerciseName] = useState('Squat');
  const [weight, setWeight] = useState('60');
  const [targetReps, setTargetReps] = useState('5');
  const [plateDiameter, setPlateDiameter] = useState(String(DEFAULT_PLATE_DIAMETER_MM));
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('imperial');
  const [demoMode, setDemoMode] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationState>('IDLE');
  const [cameraReady, setCameraReady] = useState(false);
  const [trackingLost, setTrackingLost] = useState(false);
  const [calibrationDetail, setCalibrationDetail] = useState<string | null>(null);
  const [manualBounds, setManualBounds] = useState<CvRepBounds[]>([]);
  const [summary, setSummary] = useState<SetSummary>({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0 });
  const [result, setResult] = useState<SetAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tracker = useVbtTracker(measurementModeForExercise(exerciseName) === 'SQUAT_CV' ? 'FREE_WEIGHT_SIDE' : 'PULLEY_FRONT');
  const imuSamples = useRef<Array<{ x: number; y: number; z: number; timestamp: number }>>([]);
  const cvFrames = useRef<CvFramePoint[]>([]);
  const cameraRef = useRef<CameraView | null>(null);
  const cvCaptureBusy = useRef(false);
  const lastCvFrameAt = useRef<number | null>(null);
  const calibrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calibrationSubscription = useRef<{ remove: () => void } | null>(null);
  const startedAt = useRef(0);
  const finalized = useRef(false);
  const recordingSessionId = useRef(0);
  const captureId = useRef<string | null>(null);
  useKeepAwake();

  const mode = measurementModeForExercise(exerciseName);
  const isSquat = mode === 'SQUAT_CV';
  const weightKg = useMemo(() => {
    const parsed = Number(weight);
    return Number.isFinite(parsed) && parsed > 0 ? toCanonicalKg(parsed, unitSystem) : 0;
  }, [weight, unitSystem]);
  const plateDiameterMm = Number(plateDiameter);

  useEffect(() => { AsyncStorage.getItem(UNIT_STORAGE_KEY).then((value) => { if (value === 'imperial' || value === 'metric') setUnitSystem(value); }).catch(() => undefined); }, []);
  useEffect(() => { AsyncStorage.setItem(UNIT_STORAGE_KEY, unitSystem).catch(() => undefined); }, [unitSystem]);
  useEffect(() => () => {
    if (calibrationTimer.current) clearTimeout(calibrationTimer.current);
    calibrationSubscription.current?.remove();
  }, []);

  useEffect(() => {
    if (phase !== 'RECORD' || isSquat || demoMode) return;
    Accelerometer.setUpdateInterval(IMU_INTERVAL_MS);
    const subscription = Accelerometer.addListener((data) => {
      const timestamp = Date.now();
      imuSamples.current.push({ x: data.x, y: data.y, z: data.z, timestamp });
      tracker.updateImu(data.z * 9.81, timestamp);
    });
    return () => subscription.remove();
  }, [demoMode, isSquat, phase, tracker.updateImu]);

  const processCameraSnapshot = useCallback((base64: string, timestamp: number, sessionId: number) => {
    if (sessionId !== recordingSessionId.current || phase !== 'RECORD') return null;
    const { rgba, width, height } = decodeCameraFrame(base64);
    const deltaSeconds = lastCvFrameAt.current == null ? CV_SNAPSHOT_INTERVAL_MS / 1000 : Math.max(0.03, (timestamp - lastCvFrameAt.current) / 1000);
    lastCvFrameAt.current = timestamp;
    const snapshot = tracker.processFrame(rgba, width, height, deltaSeconds);
    cvFrames.current.push({
      timestamp,
      displacementM: snapshot.displacement,
      tracked: snapshot.centroid !== null,
      confidence: snapshot.trackingConfidence,
    });
    setTrackingLost(snapshot.centroid === null);
    return snapshot;
  }, [phase, tracker.processFrame]);

  useEffect(() => {
    if (phase !== 'RECORD' || !isSquat) return;
    const sessionId = recordingSessionId.current;
    const captureSnapshot = async () => {
      if (cvCaptureBusy.current || !cameraRef.current) return;
      cvCaptureBusy.current = true;
      try {
        const picture = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.1, skipProcessing: true });
        if (picture.base64) setTrackingLost(processCameraSnapshot(picture.base64, Date.now(), sessionId) === null);
        else setTrackingLost(true);
      } catch {
        setTrackingLost(true);
      } finally {
        cvCaptureBusy.current = false;
      }
    };
    void captureSnapshot();
    const interval = setInterval(() => { void captureSnapshot(); }, CV_SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isSquat, phase, processCameraSnapshot]);

  const changeUnit = useCallback((next: UnitSystem) => {
    const parsed = Number(weight);
    if (Number.isFinite(parsed) && parsed > 0) setWeight(fromCanonicalKg(toCanonicalKg(parsed, unitSystem), next).toFixed(1));
    setUnitSystem(next);
  }, [unitSystem, weight]);

  const calibrateImu = useCallback(() => {
    setCalibration('CAPTURING');
    setCalibrationDetail(null);
    const rest: number[] = [];
    Accelerometer.setUpdateInterval(IMU_INTERVAL_MS);
    calibrationSubscription.current?.remove();
    const sub = Accelerometer.addListener((data) => rest.push(data.z * 9.81));
    calibrationSubscription.current = sub;
    calibrationTimer.current = setTimeout(() => {
      sub.remove();
      calibrationSubscription.current = null;
      const calibrated = tracker.calibrateImu(rest);
      setCalibration(calibrated ? 'READY' : 'FAILED');
      setCalibrationDetail(
        calibrated
          ? `Sensor confidence ${Math.round(tracker.calibrationConfidence * 100)}%.`
          : 'The stack moved or the sensor data was insufficient. Keep it still and retry.',
      );
    }, REST_CALIBRATION_MS);
  }, [tracker.calibrateImu, tracker.calibrationConfidence]);

  const calibrateSquatCamera = useCallback(async () => {
    if (!cameraRef.current) return;
    setCalibration('CAPTURING');
    setCalibrationDetail(null);
    try {
      const picture = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.1, skipProcessing: true });
      if (!picture.base64) throw new Error('Camera pixels were unavailable.');
      const frame = decodeCameraFrame(picture.base64);
      const observation = tracker.calibratePlateFromFrame(
        frame.rgba,
        frame.width,
        frame.height,
        plateDiameterMm / 1000,
      );
      if (!observation || !tracker.calibrated) {
        setCalibration('FAILED');
        setCalibrationDetail('Target confidence was too low. Center the plate in the red guide, improve lighting, and retry.');
        return;
      }
      setCalibration('READY');
      setCalibrationDetail(
        `Detected ${Math.round(observation.diameterPx)} px · confidence ${Math.round(observation.confidence * 100)}%.`,
      );
    } catch {
      setCalibration('FAILED');
      setCalibrationDetail('Camera calibration failed. Keep the plate fully visible in the red guide and retry.');
    }
  }, [plateDiameterMm, tracker.calibratePlateFromFrame, tracker.calibrated]);

  const begin = useCallback(async () => {
    if (!exerciseName.trim() || weightKg <= 0 || Number(targetReps) < 1) {
      setError('Enter an exercise, a positive load, and at least one target repetition.');
      return;
    }
    if (isSquat && (!Number.isFinite(plateDiameterMm) || plateDiameterMm < 100 || plateDiameterMm > 1000)) {
      setError('Enter a plate or sleeve diameter between 100 and 1000 mm for Squat CV.');
      return;
    }
    if (isSquat && !permission?.granted) {
      const granted = await requestPermission();
      if (!granted.granted) { setError('Camera permission is required for the Squat CV path.'); return; }
    }
    setError(null);
    if (demoMode) { setSummary({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0, measurementStatus: 'REHEARSAL', unavailableReason: 'Rehearsal mode never creates a velocity measurement.' }); setPhase('FEEDBACK'); return; }
    if (isSquat) {
      setPhase('CALIBRATE');
      return;
    }
    if (!tracker.calibrated) { setPhase('CALIBRATE'); return; }
    imuSamples.current = [];
    startedAt.current = Date.now();
    finalized.current = false;
    setPhase('RECORD');
  }, [demoMode, exerciseName, isSquat, permission?.granted, plateDiameterMm, requestPermission, targetReps, tracker.calibrated, weightKg]);

  const startRecording = () => {
    recordingSessionId.current += 1;
    captureId.current = `capture-${Date.now().toString(36)}-${recordingSessionId.current}`;
    imuSamples.current = [];
    cvFrames.current = [];
    lastCvFrameAt.current = null;
    manualBounds.length && setManualBounds([]);
    startedAt.current = Date.now();
    finalized.current = false;
    setTrackingLost(false);
    setPhase('RECORD');
  };

  const submit = useCallback(async (nextSummary: SetSummary, manualRepBoundsUsed: boolean) => {
    const reps = nextSummary.reps;
    if (nextSummary.measurementStatus !== 'MEASURED' || reps.length === 0) {
      setSummary({ ...nextSummary, measurementStatus: 'UNAVAILABLE', unavailableReason: 'No complete calibrated repetitions were detected.' });
      setPhase('FEEDBACK');
      return;
    }
    if (!process.env.EXPO_PUBLIC_DOMAIN?.trim()) {
      setError('The analysis service is not configured. Set EXPO_PUBLIC_DOMAIN, then retry this completed set.');
      setSummary(nextSummary);
      setPhase('FEEDBACK');
      return;
    }
    setSummary(nextSummary);
    setPhase('PROCESSING');
    try {
      const payload = isSquat ? {
        exercise_name: 'Squat',
        weight_kg: weightKg,
        display_unit: unitSystem,
        display_load: Number(weight),
        target_reps: Number(targetReps),
        total_sets: 1,
        plate_diameter_mm: plateDiameterMm,
        mean_velocity_ms: reps.reduce((sum, rep) => sum + (rep.meanVelocity ?? 0), 0) / reps.length,
        peak_velocity_ms: Math.max(...reps.map((rep) => rep.peakVelocity ?? 0)),
        first_rep_peak_ms: reps[0]?.peakVelocity ?? null,
        rep_peaks_ms: reps.map((rep) => rep.peakVelocity ?? 0),
        actual_reps: reps.length,
        duration_s: (Date.now() - startedAt.current) / 1000,
        sample_count: cvFrames.current.length,
        manual_rep_bounds_used: manualRepBoundsUsed,
        capture_id: captureId.current ?? undefined,
      } : {
        exercise_name: 'Lat Pulldown',
        weight_kg: weightKg,
        display_unit: unitSystem,
        display_load: Number(weight),
        target_reps: Number(targetReps),
        total_sets: 1,
        phone_placement: 'weight_stack' as const,
        samples: imuSamples.current,
        capture_id: captureId.current ?? undefined,
      };
      const response = await analyzeSet(payload);
      setResult(response);
      setPhase('FEEDBACK');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Set analysis failed.');
      setPhase('FEEDBACK');
    }
  }, [isSquat, plateDiameterMm, targetReps, unitSystem, weight, weightKg]);

  const stopRecording = () => {
    if (finalized.current) return;
    finalized.current = true;
    recordingSessionId.current += 1;
    if (!isSquat) {
      const completed = tracker.stopSet().completedSet ?? summary;
      const decorated = { ...completed, durationSec: (Date.now() - startedAt.current) / 1000, sampleCount: imuSamples.current.length, inferenceSource: 'IMU' as const, limitations: ['Phone is mounted to the Lat Pulldown weight stack; Z-axis IMU estimate.'] };
      void submit(decorated, false);
      return;
    }
    const frames = trimRackingNoise(cvFrames.current, Date.now());
    cvFrames.current = frames;
    const cvSummary = tracker.stopSet().completedSet ?? summary;
    const confidence = getCvTrackingConfidence(frames);
    if (needsManualCvReview(frames, cvSummary.reps)) {
      setSummary({ ...cvSummary, confidence: confidence >= 0.85 ? 'MEDIUM' : 'LOW', dataQuality: confidence >= 0.85 ? 'GOOD' : 'DEGRADED', measurementStatus: 'UNAVAILABLE', unavailableReason: `CV confidence was ${Math.round(confidence * 100)}%. Review only if confidence is at least 85%; otherwise retake with better lighting and a perpendicular camera.` });
      setPhase('POST_REVIEW');
      return;
    }
    void submit({ ...cvSummary, confidence: 'HIGH', dataQuality: 'GOOD', inferenceSource: 'MANUAL', sampleCount: frames.length, durationSec: (Date.now() - startedAt.current) / 1000 }, false);
  };

  const applyManualReview = () => {
    const reps = deriveCvRepMetrics(cvFrames.current, manualBounds);
    const updated: SetSummary = {
      reps,
      meanRepTime: reps.length ? reps.reduce((sum, rep) => sum + rep.repTimeSec, 0) / reps.length : 0,
      topSpeed: Math.max(0, ...reps.map((rep) => rep.peakVelocity ?? 0)),
      peakVelocities: reps.map((rep) => rep.peakVelocity ?? 0),
      consistencyScore: 0,
      measurementStatus: reps.length && getCvTrackingConfidence(cvFrames.current) >= 0.85 ? 'MEASURED' : 'UNAVAILABLE',
      unavailableReason: reps.length ? 'Manual rep bounds are below the 85% tracking-confidence gate. Metrics remain withheld from trusted history.' : 'Manual ranges need tracked CV frames. Retake with the plate clearly visible in the camera guide.',
      dataQuality: getCvTrackingConfidence(cvFrames.current) >= 0.85 ? 'GOOD' : 'DEGRADED',
      confidence: getCvTrackingConfidence(cvFrames.current) >= 0.85 ? 'MEDIUM' : 'LOW',
      inferenceSource: 'MANUAL',
      sampleCount: cvFrames.current.length,
      durationSec: (Date.now() - startedAt.current) / 1000,
    };
    if (updated.measurementStatus !== 'MEASURED') { setSummary(updated); setPhase('FEEDBACK'); return; }
    void submit(updated, true);
  };

  const reset = () => {
    recordingSessionId.current += 1;
    captureId.current = null;
    if (calibrationTimer.current) clearTimeout(calibrationTimer.current);
    calibrationSubscription.current?.remove();
    calibrationSubscription.current = null;
    tracker.resetTracker();
    setPhase('SETUP'); setCalibration('IDLE'); setCalibrationDetail(null); setResult(null); setError(null); setCameraReady(false); setTrackingLost(false); setManualBounds([]);
    setSummary({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0 });
  };

  if (phase === 'RECOVERY') return <View style={[styles.root, { paddingTop: insets.top }]}><Recovery onBack={() => setPhase('FEEDBACK')} /></View>;
  if (phase === 'FEEDBACK') return <View style={[styles.root, { paddingTop: insets.top }]}><Feedback exerciseName={exerciseName} unitSystem={unitSystem} weightKg={weightKg} summary={summary} result={result} error={error} onRestart={reset} onRecovery={() => setPhase('RECOVERY')} /></View>;
  if (phase === 'PROCESSING') return <View style={styles.center}><ActivityIndicator color="#FFFF00" size="large" /><Text style={styles.title}>Analyzing your set</Text><Text style={styles.body}>Checking load-matched history, readiness, and evidence-based coaching…</Text></View>;

  if (phase === 'POST_REVIEW') return <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 20 }]}>
    <Text style={styles.eyebrow}>SQUAT CV · POST-SET REVIEW</Text><Text style={styles.title}>Confirm rep ranges</Text>
    <Text style={styles.body}>Tracking was low confidence or rep boundaries were incomplete. Racking noise has been excluded. Add start/end frame ranges only when the plate was visibly tracked.</Text>
    <View style={styles.timeline}>{cvFrames.current.length ? cvFrames.current.map((frame, index) => <View key={`${frame.timestamp}-${index}`} style={[styles.timelineMark, frame.tracked ? styles.timelineTracked : styles.timelineLost]} />) : <Text style={styles.caption}>No usable camera frames reached the local CV tracker. Retake with the plate fully visible, profile-on, and well lit.</Text>}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>Manual rep bounds</Text><Text style={styles.caption}>Frame indices are local to this set. Add a range for each complete descent-and-ascent repetition.</Text>
      <View style={styles.row}><Button label="ADD REP RANGE" onPress={() => setManualBounds((bounds) => [...bounds, { startIndex: 0, endIndex: Math.max(1, cvFrames.current.length - 1) }])} secondary /></View>
      {manualBounds.map((bound, index) => <View key={index} style={styles.boundsRow}><Text style={styles.repName}>REP {index + 1}</Text><TextInput value={String(bound.startIndex)} keyboardType="number-pad" onChangeText={(value) => setManualBounds((all) => all.map((item, position) => position === index ? { ...item, startIndex: Number(value) || 0 } : item))} style={styles.boundsInput} /><Text style={styles.caption}>to</Text><TextInput value={String(bound.endIndex)} keyboardType="number-pad" onChangeText={(value) => setManualBounds((all) => all.map((item, position) => position === index ? { ...item, endIndex: Number(value) || 0 } : item))} style={styles.boundsInput} /></View>)}
      <Button label="RECALCULATE FROM MANUAL RANGES" disabled={!manualBounds.length} onPress={applyManualReview} />
    </View><Button label="RETAKE SQUAT SET" secondary onPress={reset} />
  </ScrollView>;

  if (phase === 'CALIBRATE') return <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 20 }]}>
    <Text style={styles.eyebrow}>{isSquat ? 'SQUAT · CAMERA CALIBRATION' : 'LAT PULLDOWN · IMU CALIBRATION'}</Text><Text style={styles.title}>{isSquat ? 'Lock the plate view.' : 'Capture still rest.'}</Text>
    {isSquat ? <View style={styles.card}>
      <Text style={styles.cardTitle}>Profile-view camera only</Text><Text style={styles.body}>Another person films from exactly perpendicular to the lifter at hip/knee height. Keep the full plate or sleeve visible; do not attach the phone to the barbell.</Text>
       <Text style={styles.caption}>Tripod/stand required. Scale uses the observed target diameter and your {plateDiameterMm} mm reference; lighting, occlusion, and perspective affect confidence.</Text>
      {!permission?.granted ? <Button label="ALLOW CAMERA" onPress={() => { void requestPermission(); }} /> : <View style={styles.cameraPreview}><CameraView ref={cameraRef} facing="back" style={StyleSheet.absoluteFillObject} onCameraReady={() => setCameraReady(true)} /><View pointerEvents="none" style={[styles.trackingBox, !cameraReady && styles.trackingBoxLost]} /><Text style={styles.cameraLabel}>{cameraReady ? 'ALIGN PLATE IN RED GUIDE' : 'STARTING CAMERA…'}</Text></View>}
       <Button label={calibration === 'CAPTURING' ? 'DETECTING TARGET…' : 'DETECT PLATE IN GUIDE'} disabled={!cameraReady || calibration === 'CAPTURING'} onPress={() => { void calibrateSquatCamera(); }} />
       {calibrationDetail ? <Text style={calibration === 'READY' ? styles.success : styles.warning}>{calibrationDetail}</Text> : null}
       {calibration === 'READY' ? <Text style={styles.success}>Target locked. Begin only while the tripod remains stationary and the plate stays in the guide.</Text> : null}
      <Button label="START SQUAT RECORDING" disabled={calibration !== 'READY'} onPress={startRecording} />
    </View> : <View style={styles.card}>
      <Text style={styles.cardTitle}>Weight-stack IMU</Text><Text style={styles.body}>Secure the phone to the Lat Pulldown weight stack with its Z axis aligned to the stack movement. Hold it perfectly still for one second; video is not used in this mode.</Text>
       <Text style={[styles.caption, calibration === 'FAILED' && styles.warning]}>{calibration === 'CAPTURING' ? 'Capturing 50 Hz rest baseline…' : calibration === 'READY' ? 'Rest baseline captured · Z-axis IMU enabled' : calibration === 'FAILED' ? 'Calibration was unstable. Keep the stack still and retry.' : 'Velocity remains unavailable until rest calibration succeeds.'}</Text>
       {calibrationDetail ? <Text style={calibration === 'READY' ? styles.success : styles.warning}>{calibrationDetail}</Text> : null}
      <Button label={calibration === 'CAPTURING' ? 'CAPTURING REST…' : 'CAPTURE 1-SECOND REST'} disabled={calibration === 'CAPTURING'} onPress={calibrateImu} /><Button label="START LAT PULLDOWN SET" disabled={calibration !== 'READY'} onPress={startRecording} />
    </View>}
    <Button label="BACK TO SETUP" secondary onPress={() => setPhase('SETUP')} />
  </ScrollView>;

  if (phase === 'SETUP') return <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 20 }]}>
    <Text style={styles.eyebrow}>FREELOCITY · VBT COACH</Text><Text style={styles.title}>Choose the measurement.</Text><Text style={styles.body}>Squat uses local camera-based plate movement. Lat Pulldown uses the phone’s Z-axis accelerometer on the weight stack.</Text>
    <Button label="OPEN GYM DIARY" secondary onPress={() => router.push('/diary')} />
    <View style={styles.card}><Text style={styles.cardTitle}>Exercise</Text><View style={styles.row}><Button label="SQUAT · CAMERA CV" secondary={!isSquat} onPress={() => { setExerciseName('Squat'); setCalibration('IDLE'); tracker.resetTracker(); }} /><Button label="LAT PULLDOWN · IMU" secondary={isSquat} onPress={() => { setExerciseName('Lat Pulldown'); setCalibration('IDLE'); tracker.resetTracker(); }} /></View><Text style={styles.caption}>{isSquat ? 'A training partner films from the side. Keep the camera perpendicular—an oval plate breaks spatial scale.' : 'Mount the phone securely to the weight stack. The camera is not used.'}</Text></View>
    <View style={styles.card}><Text style={styles.cardTitle}>Set setup</Text><Text style={styles.label}>LOAD · {getUnitConfig(unitSystem).abbreviation.toUpperCase()}</Text><TextInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" style={styles.input} /><Text style={styles.label}>TARGET REPS</Text><TextInput value={targetReps} onChangeText={setTargetReps} keyboardType="number-pad" style={styles.input} />{isSquat ? <><Text style={styles.label}>PLATE / SLEEVE DIAMETER · MM</Text><TextInput value={plateDiameter} onChangeText={setPlateDiameter} keyboardType="number-pad" style={styles.input} /><Text style={styles.caption}>Defaults to a standard 450 mm plate. This measurement sets the CV pixel-to-meter scale.</Text></> : null}<View style={styles.switchRow}><Text style={styles.body}>Rehearsal-only fallback</Text><Switch value={demoMode} onValueChange={setDemoMode} /></View><Text style={styles.caption}>{demoMode ? 'Rehearsal never saves velocity, readiness, or AI coaching.' : isSquat ? 'Live Squat uses the rear camera only; no barbell-mounted phone.' : 'Live Lat Pulldown records timestamped Z-axis accelerometer samples at 50 Hz.'}</Text></View>
    <View style={styles.card}><Text style={styles.cardTitle}>Mass units</Text><UnitToggle value={unitSystem} onChange={changeUnit} /><Text style={styles.caption}>Imperial is the default display. Stored loads and comparisons remain canonical kilograms.</Text></View>
    {error ? <Text style={styles.warning}>{error}</Text> : null}<Button label={demoMode ? 'START REHEARSAL' : isSquat ? 'CALIBRATE SQUAT CAMERA' : 'CALIBRATE LAT PULLDOWN IMU'} onPress={() => { void begin(); }} />
  </ScrollView>;

  return <View style={styles.root}>{isSquat ? <CameraView ref={cameraRef} facing="back" style={StyleSheet.absoluteFillObject} onCameraReady={() => setCameraReady(true)} /> : null}<View style={styles.shade} /><View style={[styles.record, { paddingTop: insets.top + 20 }]}><Text style={styles.eyebrow}>{isSquat ? trackingLost ? 'CV TRACKING LOST' : 'SQUAT CV · PROFILE VIEW' : 'LAT PULLDOWN IMU · Z AXIS'}</Text><Text style={styles.title}>{exerciseName} set in progress</Text>{isSquat ? <View style={[styles.trackingBox, trackingLost && styles.trackingBoxLost]} /> : null}<View style={styles.liveCard}><Metric label="REPS DETECTED" value={String(tracker.reps.length)} /><Metric label="VELOCITY" value={tracker.currentVelocity == null ? 'Awaiting data' : `${tracker.currentVelocity.toFixed(2)} m/s`} note={isSquat ? 'local CV estimate · 5 Hz snapshots' : 'Z-axis IMU estimate'} />{isSquat ? <Metric label="TRACKING CONFIDENCE" value={`${Math.round(tracker.trackingConfidence * 100)}%`} note="85% required for trusted history" /> : <Metric label="REST CONFIDENCE" value={`${Math.round(tracker.calibrationConfidence * 100)}%`} note="stationary Z-axis baseline" />}<Text style={styles.body}>{isSquat ? trackingLost ? 'Tracking paused. Lost frames are excluded; restore the plate to the guide before continuing.' : 'Keep the plate inside the red guide. Tap Stop before racking the bar.' : 'Phone stays secured on the stack. Direction changes determine repetitions; no video is recorded.'}</Text></View><View style={styles.recordActions}>{isSquat ? <Button label={trackingLost ? 'RESUME TRACKING' : 'MARK TRACKING LOST'} secondary onPress={() => setTrackingLost((lost) => !lost)} /> : null}<Button label="STOP & REVIEW" onPress={stopRecording} /></View><Text style={styles.caption}>{isSquat ? 'Manual Stop trims final racking noise. Low-confidence captures open post-set review.' : 'At least 20 timestamped samples are required. Do not move the phone off the stack.'}</Text></View></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07151F' }, page: { backgroundColor: '#07151F', padding: 20, paddingBottom: 42, gap: 16, flexGrow: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#07151F', padding: 28, gap: 14 }, record: { flex: 1, padding: 20, gap: 16 }, shade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(7,21,31,0.57)' }, eyebrow: { color: '#FFFF00', fontSize: 11, fontWeight: '900', letterSpacing: 1.3 }, title: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', letterSpacing: -1 }, body: { color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 21 }, caption: { color: 'rgba(255,255,255,0.5)', fontSize: 11, lineHeight: 16 }, warning: { color: '#FF8069', fontSize: 13, fontWeight: '800', lineHeight: 19 }, success: { color: '#00FF88', fontSize: 12, fontWeight: '800', lineHeight: 18 }, card: { backgroundColor: '#102633', borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 }, cardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' }, label: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '900', letterSpacing: 1 }, input: { color: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.28)', fontSize: 20, paddingVertical: 7 }, row: { flexDirection: 'row', gap: 8 }, button: { flex: 1, minHeight: 48, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00A99D', borderRadius: 13 }, buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#00FF88' }, buttonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 0.7, textAlign: 'center' }, buttonSecondaryText: { color: '#00FF88' }, switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, unitToggle: { flexDirection: 'row', gap: 8 }, unit: { flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', borderRadius: 12, padding: 10 }, unitSelected: { backgroundColor: '#00A99D', borderColor: '#00FF88' }, unitText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '800' }, unitTextSelected: { color: '#FFFFFF' }, cameraPreview: { height: 220, overflow: 'hidden', borderRadius: 14, backgroundColor: '#07151F', justifyContent: 'center', alignItems: 'center' }, cameraLabel: { color: '#FFFFFF', backgroundColor: 'rgba(0,0,0,0.54)', padding: 7, borderRadius: 7, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 }, trackingBox: { position: 'absolute', alignSelf: 'center', top: '28%', width: 148, height: 148, borderWidth: 3, borderColor: '#FF3B30', borderRadius: 6 }, trackingBoxLost: { borderStyle: 'dashed', borderColor: '#FF8069', opacity: 0.6 }, liveCard: { backgroundColor: 'rgba(7,21,31,0.9)', borderRadius: 18, padding: 16, gap: 12, marginTop: 'auto' }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { width: '48%', minHeight: 92, backgroundColor: '#102633', padding: 12, borderRadius: 14 }, metricLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 9, fontWeight: '900' }, metricValue: { color: '#FFFFFF', fontSize: 21, fontWeight: '900', marginTop: 10 }, metricNote: { color: '#00FF88', fontSize: 10, marginTop: 4 }, source: { backgroundColor: '#183B3D', borderRadius: 14, padding: 14, gap: 6 }, sourceText: { color: '#00FF88', fontSize: 11, fontWeight: '900', letterSpacing: 1 }, repRow: { flexDirection: 'row', gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' }, repName: { color: '#FFFF00', fontSize: 11, fontWeight: '900', minWidth: 42 }, repMetric: { color: 'rgba(255,255,255,0.7)', fontSize: 11, flex: 1 }, readiness: { color: '#FFFF00', fontSize: 36, fontWeight: '900' }, recordActions: { flexDirection: 'row', gap: 10 }, timeline: { minHeight: 62, padding: 12, borderRadius: 14, backgroundColor: '#102633', flexDirection: 'row', flexWrap: 'wrap', gap: 3 }, timelineMark: { width: 5, height: 32, borderRadius: 2 }, timelineTracked: { backgroundColor: '#00FF88' }, timelineLost: { backgroundColor: '#FF8069' }, boundsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, boundsInput: { width: 54, color: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.28)', textAlign: 'center', paddingVertical: 4 }
});
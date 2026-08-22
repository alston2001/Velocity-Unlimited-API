import { Accelerometer } from 'expo-sensors';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { analyzeSet, useGetDemoHistory, type DemoHistoricalSet, type SetAnalysisResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useConcussionTracker } from '@/src/hooks/useConcussionTracker';
import { convertHistoryLoads, formatMassFromKg, fromCanonicalKg, getUnitConfig, toCanonicalKg, type UnitSystem } from '@/src/lib/units';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';
import type { SetSummary } from '@/src/lib/vbtTracker';

type Phase = 'SETUP' | 'CALIBRATE' | 'RECORD' | 'PROCESSING' | 'FEEDBACK' | 'RECOVERY';
type Placement = 'barbell';
type Colors = ReturnType<typeof useColors>;
const UNIT_STORAGE_KEY = 'freelocity.unit-system';
const REST_CALIBRATION_MS = 1000;

const seededSamples = () =>
  Array.from({ length: 181 }, (_, i) => {
    const t = i * 100;
    const cycle = Math.sin(i / 8) * 0.16 + Math.sin(i / 3) * 0.02;
    return { x: 0, y: 0, z: cycle, timestamp: t };
  });

function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, { opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text>{note && <Text style={styles.metricNote}>{note}</Text>}</View>;
}

function UnitToggle({ value, onChange }: { value: UnitSystem; onChange: (value: UnitSystem) => void }) {
  return <View style={styles.unitToggle}>
    {(['imperial', 'metric'] as const).map((system) => (
      <Pressable
        key={system}
        testID={`unit-${system}`}
        onPress={() => onChange(system)}
        style={[styles.unitOption, value === system && styles.unitOptionActive]}
      >
        <Text style={[styles.unitOptionText, value === system && styles.unitOptionTextActive]}>{getUnitConfig(system).label}</Text>
        <Text style={[styles.unitOptionSubtext, value === system && styles.unitOptionTextActive]}>{getUnitConfig(system).abbreviation}</Text>
      </Pressable>
    ))}
  </View>;
}

function HistoryCard({ rows, unitSystem, loading }: { rows: DemoHistoricalSet[]; unitSystem: UnitSystem; loading: boolean }) {
  const displayRows = convertHistoryLoads(rows, unitSystem);
  return <View style={styles.card}>
    <Text style={styles.cardTitle}>24-set history · {getUnitConfig(unitSystem).label}</Text>
    <Text style={styles.body}>Canonical history loads are stored in kg; these labels update with your unit preference.</Text>
    {loading ? <Text style={styles.caption}>Loading canonical demo history…</Text> : displayRows.length === 0 ? <Text style={styles.caption}>History unavailable until the API responds.</Text> :
      <View style={styles.historyList}>{displayRows.map((row) => <View key={row.id} style={styles.historyRow}><Text style={styles.historySet}>SET {row.setNumber}</Text><Text style={styles.historyLoad}>{row.displayLoad.toFixed(1)} {row.displayUnit}</Text><Text style={styles.historyMeta}>{row.actualReps} reps · {row.velocityLossPct.toFixed(0)}% loss</Text></View>)}</View>}
  </View>;
}

function Recovery({ colors, onBack }: { colors: Colors; onBack: () => void }) {
  const tracker = useConcussionTracker();
  const [consent, setConsent] = useState(false);
  const [started, setStarted] = useState(false);
  const [balanceDone, setBalanceDone] = useState(false);
  const questions = [
    ['orientation', 'What day of the week is it?'],
    ['concentration', 'Repeat these numbers backward: 4 · 8 · 2'],
    ['memory', 'Do you remember the instructions you just read?'],
  ] as const;
  const answer = (domain: 'orientation' | 'concentration' | 'memory', correct: boolean) => {
    tracker.recordAnswer(correct, domain);
    setStarted(true);
  };
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.eyebrow}>SEPARATE SAFETY CHECK</Text>
      <Text style={styles.title}>Recovery check-in</Text>
      <Text style={styles.body}>This is a conservative screening aid, not a concussion diagnosis. Do not use it to clear someone to play.</Text>
      {!consent ? <View style={styles.card}><Text style={styles.cardTitle}>Before you begin</Text><Text style={styles.body}>I understand this check-in is optional, results are uncertain, and symptoms require a qualified professional.</Text><Button label="I CONSENT · START CHECK" onPress={() => setConsent(true)} /></View> :
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cognitive prompts</Text>
          {questions.map(([domain, question]) => <View key={domain} style={styles.question}><Text style={styles.body}>{question}</Text><View style={styles.row}><Button label="CORRECT" onPress={() => answer(domain, true)} secondary /><Button label="INCORRECT" onPress={() => answer(domain, false)} secondary /></View></View>)}
          <Text style={styles.cardTitle}>Balance</Text>
          <Text style={styles.body}>Stand still only if safe. Stop immediately for dizziness or worsening symptoms.</Text>
          {!balanceDone ? <Button label="COMPLETE 10-SECOND BALANCE CHECK" onPress={() => { tracker.startBalance(); tracker.recordBalanceSample({ x: 0.2, y: 0.1, z: 0.05 }); setBalanceDone(true); tracker.completeBalance(10); }} /> : <Text style={styles.success}>Balance sample recorded · estimated sway only</Text>}
          {started && <View style={styles.result}><Text style={styles.cardTitle}>Conservative result · {tracker.assessment.riskTier}</Text><Text style={styles.body}>{tracker.assessment.correctAnswers}/3 cognitive prompts marked correct. This cannot rule out concussion.</Text>{tracker.assessment.riskTier !== 'LOW' && <Text style={styles.warning}>STOP EXERCISE and seek athletic-trainer or medical-professional guidance now.</Text>}<Text style={styles.body}>If there are severe or worsening symptoms, seek urgent care.</Text></View>}
        </View>}
      <Button label="BACK TO SQUAT FEEDBACK" onPress={onBack} secondary />
    </ScrollView>
  );
}

function Feedback({ result, fallback, error, colors, onRecovery, onRestart, unitSystem, weightKg, exerciseName }: { result: SetAnalysisResult | null; fallback: SetSummary; error: string | null; colors: Colors; onRecovery: () => void; onRestart: () => void; unitSystem: UnitSystem; weightKg: number; exerciseName: string }) {
  const isMeasured = fallback.measurementStatus === 'MEASURED';
  const r = isMeasured ? result : null;
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>SET FEEDBACK · {exerciseName.toUpperCase()}</Text><Text style={styles.title}>What changed today</Text>
    <View style={styles.source}><Text style={styles.sourceText}>{isMeasured ? 'IMU MEASUREMENT · CALIBRATED' : 'VELOCITY UNAVAILABLE'}</Text><Text style={styles.body}>{isMeasured ? 'Velocity was derived from calibrated IMU samples using their recorded timestamps.' : fallback.unavailableReason ?? 'This capture did not produce a supportable velocity measurement. Recalibrate at rest and retake the set.'}</Text></View>
    <View style={styles.grid}>
       <Metric label="LOAD" value={formatMassFromKg(weightKg, unitSystem)} note="display preference" />
      <Metric label="REPS" value={String(r?.actual_reps ?? fallback.reps.length)} />
      <Metric label="MEAN VELOCITY" value={isMeasured ? `${(r?.mean_velocity_ms ?? 0).toFixed(3)} m/s` : 'Unavailable'} note={isMeasured ? 'calibrated IMU' : 'not submitted'} />
      <Metric label="PEAK VELOCITY" value={isMeasured ? `${(r?.peak_velocity_ms ?? fallback.topSpeed).toFixed(3)} m/s` : 'Unavailable'} note={isMeasured ? 'per-rep bounded' : 'not measured'} />
      <Metric label="VELOCITY LOSS" value={isMeasured && r?.velocity_loss_pct != null ? `${r.velocity_loss_pct.toFixed(1)}%` : '—'} note={isMeasured ? r?.fatigue_level ?? 'needs ≥2 reps' : 'not available'} />
      <Metric label="DURATION" value={`${(r?.duration_s ?? fallback.durationSec ?? 0).toFixed(1)} s`} />
      <Metric label="DATA QUALITY" value={isMeasured ? 'MEASURED' : 'WITHHELD'} note={isMeasured ? `${r?.sample_count ?? fallback.sampleCount ?? 0} timestamped samples` : 'no coaching or readiness'} />
    </View>
    <View style={styles.card}><Text style={styles.cardTitle}>Rep-by-rep breakdown</Text>{fallback.reps.length > 0 ? fallback.reps.map((rep) => <View key={rep.repNumber} style={styles.repRow}><Text style={styles.repName}>REP {rep.repNumber}</Text><Text style={styles.repMetric}>{rep.repTimeSec.toFixed(2)} s</Text><Text style={styles.repMetric}>{rep.meanVelocity == null ? 'Mean unavailable' : `${rep.meanVelocity.toFixed(3)} m/s mean`}</Text><Text style={styles.repMetric}>{rep.peakVelocity == null ? 'Peak unavailable' : `${rep.peakVelocity.toFixed(3)} m/s peak`}</Text></View>) : <Text style={styles.body}>No complete, calibrated reps were detected. Velocity metrics remain unavailable.</Text>}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>Readiness · load matched</Text><Text style={styles.readiness}>{r?.cns_readiness_score == null ? 'Building baseline' : `${r.cns_readiness_score}/100`}</Text><Text style={styles.body}>{r?.motor_readiness_level ?? 'Unavailable without a valid measurement'} · trend: {r?.velocity_trend ?? 'Unavailable'}</Text>{r?.baseline_velocity_ms != null && <Text style={styles.body}>Baseline first-rep peak: {r.baseline_velocity_ms.toFixed(3)} m/s</Text>}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>Historical profile · {exerciseName}</Text><Text style={styles.body}>{r?.historical_comparison ?? 'Historical comparison is unavailable because this capture was not a valid measurement.'}</Text>{r?.historical_comparison_delta_pct != null && <Text style={styles.success}>{Math.abs(r.historical_comparison_delta_pct).toFixed(1)}% {r.historical_comparison_delta_pct >= 0 ? 'faster' : 'slower'} than your load-matched mean · {r.historical_comparison_data_points} sessions</Text>}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>AI coach · evidence grounded</Text>{!r && <Text style={styles.warning}>{isMeasured ? `Analysis request failed: ${error ?? 'The server did not return a result.'}` : 'Coaching and readiness were withheld because this was not a valid velocity measurement.'}</Text>}<Text style={styles.body}>{r?.ai_feedback ?? 'Retake after one second of still rest calibration with the phone secured to the barbell. Do not use this result for training validation.'}</Text><Text style={styles.disclaimer}>Recommendations are performance guidance only. No injury or concussion inference is made.</Text></View>
    <Button label="START SEPARATE RECOVERY CHECK-IN" onPress={onRecovery} secondary /><Button label="RESTART HERO SQUAT" onPress={onRestart} />
  </ScrollView>;
}

export default function MotionTrackerScreen() {
  const colors = useColors(); const insets = useSafeAreaInsets(); const router = useRouter(); const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('SETUP'); const [exerciseName, setExerciseName] = useState('Squat'); const [weight, setWeight] = useState('60'); const [targetReps, setTargetReps] = useState('5'); const placement: Placement = 'barbell'; const [demoMode, setDemoMode] = useState(false); const [summary, setSummary] = useState<SetSummary>({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0 }); const [result, setResult] = useState<SetAnalysisResult | null>(null); const [error, setError] = useState<string | null>(null); const [unitSystem, setUnitSystem] = useState<UnitSystem>('imperial'); const [unitsReady, setUnitsReady] = useState(false); const [calibrationState, setCalibrationState] = useState<'IDLE' | 'CAPTURING' | 'READY' | 'FAILED'>('IDLE');
  const samples = useRef<{ x: number; y: number; z: number; timestamp: number }[]>([]); const startedAt = useRef(0); const finished = useRef(false); const calibrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const tracker = useVbtTracker('FREE_WEIGHT_SIDE'); useKeepAwake();
  const historyQuery = useGetDemoHistory();
  const displayWeightKg = useMemo(() => {
    const parsed = Number(weight);
    return Number.isFinite(parsed) && parsed > 0 ? toCanonicalKg(parsed, unitSystem) : 0;
  }, [unitSystem, weight]);
  const changeUnit = useCallback((next: UnitSystem) => {
    const parsed = Number(weight);
    if (Number.isFinite(parsed) && parsed > 0) {
      setWeight(fromCanonicalKg(toCanonicalKg(parsed, unitSystem), next).toFixed(1));
    }
    setUnitSystem(next);
  }, [unitSystem, weight]);
  useEffect(() => {
    AsyncStorage.getItem(UNIT_STORAGE_KEY).then((stored) => {
      if (stored === 'metric' || stored === 'imperial') setUnitSystem(stored);
      setUnitsReady(true);
    }).catch(() => setUnitsReady(true));
  }, []);
  useEffect(() => {
    if (unitsReady) AsyncStorage.setItem(UNIT_STORAGE_KEY, unitSystem).catch(() => undefined);
  }, [unitSystem, unitsReady]);
  useEffect(() => () => { if (calibrationTimer.current) clearTimeout(calibrationTimer.current); }, []);
  useEffect(() => { if (phase !== 'RECORD' || demoMode) return; Accelerometer.setUpdateInterval(20); const sub = Accelerometer.addListener((data) => { const timestamp = Date.now(); samples.current.push({ x: data.x, y: data.y, z: data.z, timestamp }); const next = tracker.updateImu(data.y * 9.81, timestamp); if (next.completedSet) finish(next.completedSet); }); return () => sub.remove(); }, [demoMode, phase, tracker.updateImu]);
  const captureRestCalibration = useCallback(() => {
    setCalibrationState('CAPTURING');
    const restSamples: number[] = [];
    Accelerometer.setUpdateInterval(20);
    const sub = Accelerometer.addListener((data) => restSamples.push(data.y * 9.81));
    calibrationTimer.current = setTimeout(() => {
      sub.remove();
      const calibrated = tracker.calibrateImu(restSamples);
      setCalibrationState(calibrated ? 'READY' : 'FAILED');
    }, REST_CALIBRATION_MS);
  }, [tracker.calibrateImu]);
  const finish = useCallback(async (tracked?: SetSummary) => { if (finished.current) return; finished.current = true; const current = tracked ?? tracker.stopSet().completedSet ?? summary; const source = demoMode ? 'DEMO' : 'IMU'; const isMeasured = source === 'IMU' && current.measurementStatus === 'MEASURED'; const decorated = { ...current, durationSec: (Date.now() - startedAt.current) / 1000, sampleCount: samples.current.length, dataQuality: isMeasured ? 'GOOD' : source === 'DEMO' ? 'DEMO' : 'DEGRADED', confidence: isMeasured ? 'MEDIUM' : 'LOW', inferenceSource: source, measurementStatus: isMeasured ? 'MEASURED' : source === 'DEMO' ? 'REHEARSAL' : 'UNAVAILABLE', unavailableReason: isMeasured ? undefined : current.unavailableReason ?? (source === 'DEMO' ? 'Rehearsal data is never submitted as measured velocity.' : 'No validated IMU rep metrics were available.'), limitations: isMeasured ? ['IMU-derived estimate. Phone must remain secured to the selected axis.'] : ['Velocity was withheld; this capture was not submitted for coaching or readiness.'] } as SetSummary; setSummary(decorated); setError(decorated.unavailableReason ?? null); if (!isMeasured) { setResult(null); setPhase('FEEDBACK'); return; } setPhase('PROCESSING'); setError(null); try { const response = await analyzeSet({ exercise_name: exerciseName.trim(), weight_kg: displayWeightKg, display_unit: unitSystem, display_load: Number(weight), target_reps: Number(targetReps), total_sets: 1, phone_placement: placement === 'barbell' ? 'barbell' : 'pocket', samples: samples.current }); setResult(response); setPhase('FEEDBACK'); } catch (e) { setError(e instanceof Error ? e.message : 'Analysis request failed'); setPhase('FEEDBACK'); } }, [demoMode, displayWeightKg, exerciseName, placement, summary, targetReps, tracker.stopSet, unitSystem, weight]);
  const start = () => { if (!exerciseName.trim()) { setError('Enter the exercise you plan to film before starting.'); return; } samples.current = []; finished.current = false; startedAt.current = Date.now(); setResult(null); setError(null); if (demoMode) { setPhase('RECORD'); setTimeout(() => finish({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0, measurementStatus: 'REHEARSAL', unavailableReason: 'Rehearsal mode does not create a velocity measurement.' }), 1200); return; } if (!tracker.calibrated) { setPhase('CALIBRATE'); return; } setPhase('RECORD'); };
  const reset = () => { tracker.resetTracker(); finished.current = false; setSummary({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0 }); setPhase('SETUP'); setResult(null); setError(null); };
  if (phase === 'RECOVERY') return <View style={[styles.root, { paddingTop: insets.top }]}><Recovery colors={colors} onBack={() => setPhase('FEEDBACK')} /></View>;
  if (phase === 'FEEDBACK') return <View style={[styles.root, { paddingTop: insets.top }]}><Feedback result={result} fallback={summary} error={error} colors={colors} onRecovery={() => setPhase('RECOVERY')} onRestart={reset} unitSystem={unitSystem} weightKg={displayWeightKg} exerciseName={exerciseName.trim() || 'Exercise'} /></View>;
  if (phase === 'PROCESSING') return <View style={styles.center}><ActivityIndicator color="#FFFF00" size="large" /><Text style={styles.title}>Analyzing your set</Text><Text style={styles.body}>Integrating motion, checking load-matched readiness, and requesting grounded coaching…</Text></View>;
   if (phase === 'SETUP' || phase === 'CALIBRATE') return <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 24 }]}><Text style={styles.eyebrow}>FREELOCITY · VBT COACH</Text><Text style={styles.title}>One reliable set story.</Text><Text style={styles.body}>Choose the movement first so your measured set can be compared with the right velocity profile.</Text>{phase === 'SETUP' && <Button label="OPEN GYM DIARY" secondary onPress={() => router.push('/diary')} />}<View style={styles.stepper}><Text style={phase === 'SETUP' ? styles.stepActive : styles.step}>1 SETUP</Text><Text style={phase === 'CALIBRATE' ? styles.stepActive : styles.step}>2 CALIBRATE</Text><Text style={styles.step}>3 SET</Text><Text style={styles.step}>4 FEEDBACK</Text></View>{phase === 'CALIBRATE' ? <View style={styles.card}><Text style={styles.cardTitle}>{exerciseName.trim() || 'Exercise'} · IMU rest calibration</Text><Text style={styles.body}>Secure the phone to the barbell/load with its Y-axis aligned to movement, hold perfectly still for one second, then capture the gravity baseline. Camera preview is visual-only and does not measure velocity.</Text><Text style={calibrationState === 'READY' ? styles.success : calibrationState === 'FAILED' ? styles.warning : styles.caption}>{calibrationState === 'CAPTURING' ? 'Capturing rest samples…' : calibrationState === 'READY' ? 'Rest calibration captured · Y-axis IMU measurement enabled' : calibrationState === 'FAILED' ? 'Calibration was unstable. Hold still and retry.' : 'Velocity remains unavailable until rest calibration succeeds.'}</Text><Button label={calibrationState === 'CAPTURING' ? 'CAPTURING REST…' : 'CAPTURE 1-SECOND REST'} disabled={calibrationState === 'CAPTURING'} onPress={captureRestCalibration} /><Button label="START CALIBRATED IMU SET" disabled={!tracker.calibrated || !exerciseName.trim()} onPress={start} /><Button label="BACK TO SETUP" secondary onPress={() => setPhase('SETUP')} /></View> : <><View style={styles.card}><Text style={styles.cardTitle}>Exercise setup</Text><Text style={styles.label}>EXERCISE TO FILM</Text><TextInput value={exerciseName} onChangeText={setExerciseName} autoCapitalize="words" style={styles.input} placeholder="Squat, bench press, deadlift…" placeholderTextColor="rgba(255,255,255,0.35)" /><View style={styles.row}><Button label="USE SQUAT DEMO" secondary={exerciseName.trim().toLowerCase() !== 'squat'} onPress={() => setExerciseName('Squat')} /></View><Text style={styles.caption}>Squat is the polished demo profile. Any exercise name can be analyzed, stored, and compared with its own history.</Text>{error && <Text style={styles.warning}>{error}</Text>}<Text style={styles.label}>LOAD · {getUnitConfig(unitSystem).abbreviation.toUpperCase()}</Text><TextInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" style={styles.input} placeholder={`Enter ${getUnitConfig(unitSystem).name}`} placeholderTextColor="rgba(255,255,255,0.35)" /><Text style={styles.label}>MEASUREMENT PLACEMENT</Text><Text style={styles.success}>BARBELL-MOUNTED IMU · Y AXIS</Text><Text style={styles.label}>TARGET REPS</Text><TextInput value={targetReps} onChangeText={setTargetReps} keyboardType="number-pad" style={styles.input} /><View style={styles.switchRow}><Text style={styles.body}>Rehearsal-only fallback</Text><Switch value={demoMode} onValueChange={setDemoMode} /></View><Text style={styles.caption}>{demoMode ? 'REHEARSAL: no velocity, readiness, or AI coaching is submitted.' : 'LIVE IMU: the phone must be secured to the barbell. Camera preview is not a CV velocity source.'}</Text></View><View style={styles.card}><Text style={styles.cardTitle}>Settings & data</Text><Text style={styles.label}>MASS UNITS</Text><UnitToggle value={unitSystem} onChange={changeUnit} /><Text style={styles.caption}>Imperial is the default. Your preference is saved on this device; analytics and baselines stay canonical in kg.</Text></View><HistoryCard rows={historyQuery.data ?? []} unitSystem={unitSystem} loading={historyQuery.isLoading} /><Button label={demoMode ? 'START REHEARSAL' : tracker.calibrated ? `START ${exerciseName.trim().toUpperCase() || 'EXERCISE'} SET` : 'CALIBRATE IMU BEFORE SET'} disabled={!exerciseName.trim()} onPress={start} secondary /></>}</ScrollView>;
  return <View style={styles.root}>{permission?.granted && <CameraView facing="back" style={StyleSheet.absoluteFillObject} />}<View style={styles.shade} /><View style={[styles.record, { paddingTop: insets.top + 22 }]}><Text style={styles.eyebrow}>{demoMode ? 'REHEARSAL · NOT MEASURED' : 'CALIBRATED IMU · Y AXIS'}</Text><Text style={styles.title}>{exerciseName.trim() || 'Exercise'} set in progress</Text><View style={styles.liveCard}><Metric label="REPS DETECTED" value={String(tracker.reps.length)} /><Metric label="VELOCITY" value={tracker.currentVelocity == null ? 'Unavailable' : `${tracker.currentVelocity.toFixed(2)} m/s`} note={tracker.currentVelocity == null ? 'awaiting valid movement' : 'calibrated IMU estimate'} /><Text style={styles.body}>{demoMode ? 'Rehearsal is running. No velocity, coaching, or readiness will be generated.' : 'Camera preview is visual-only. A valid m/s value comes only from the calibrated IMU.'}</Text></View><View style={styles.recordActions}><Button label="STOP & REVIEW" onPress={() => finish()} /></View><Text style={styles.caption}>Measurement source: {demoMode ? 'rehearsal_seeded' : `imu_${placement}`}. Do not use a stationary side-camera phone for bar velocity.</Text></View></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07151F' }, page: { backgroundColor: '#07151F', padding: 20, gap: 16, paddingBottom: 40, flexGrow: 1 }, center: { flex: 1, backgroundColor: '#07151F', alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }, record: { flex: 1, padding: 20, gap: 18 }, shade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' }, eyebrow: { color: '#FFFF00', fontSize: 11, fontWeight: '900', letterSpacing: 1.4 }, title: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', letterSpacing: -1 }, body: { color: 'rgba(255,255,255,0.68)', fontSize: 14, lineHeight: 21 }, caption: { color: 'rgba(255,255,255,0.48)', fontSize: 11, lineHeight: 16 }, stepper: { flexDirection: 'row', justifyContent: 'space-between' }, step: { color: 'rgba(255,255,255,0.35)', fontSize: 9, fontWeight: '900' }, stepActive: { color: '#00FF88', fontSize: 9, fontWeight: '900' }, card: { backgroundColor: '#102633', borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 }, cardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' }, label: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '900', letterSpacing: 1 }, input: { color: '#FFFFFF', borderBottomColor: 'rgba(255,255,255,0.3)', borderBottomWidth: 1, fontSize: 20, paddingVertical: 7 }, row: { flexDirection: 'row', gap: 10 }, button: { backgroundColor: '#00A99D', borderRadius: 13, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, flex: 1 }, secondaryButton: { backgroundColor: 'transparent', borderColor: '#00FF88', borderWidth: 1 }, buttonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 0.7 }, secondaryButtonText: { color: '#00FF88' }, switchRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, unitToggle: { flexDirection: 'row', gap: 8 }, unitOption: { flex: 1, borderColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderRadius: 12, padding: 10 }, unitOptionActive: { backgroundColor: '#00A99D', borderColor: '#00FF88' }, unitOptionText: { color: 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '800' }, unitOptionTextActive: { color: '#FFFFFF' }, unitOptionSubtext: { color: 'rgba(255,255,255,0.45)', fontSize: 10, marginTop: 3 }, historyList: { borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: 1 }, historyRow: { alignItems: 'center', borderBottomColor: 'rgba(255,255,255,0.08)', borderBottomWidth: 1, flexDirection: 'row', paddingVertical: 9 }, historySet: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '800', width: 52 }, historyLoad: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', width: 78 }, historyMeta: { color: 'rgba(255,255,255,0.52)', flex: 1, fontSize: 11 }, source: { backgroundColor: '#183B3D', borderRadius: 14, padding: 14, gap: 6 }, sourceText: { color: '#00FF88', fontSize: 11, fontWeight: '900', letterSpacing: 1 }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { backgroundColor: '#102633', borderRadius: 14, minHeight: 94, padding: 12, width: '48%' }, metricLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 9, fontWeight: '900' }, metricValue: { color: '#FFFFFF', fontSize: 22, fontWeight: '900', marginTop: 10 }, metricNote: { color: '#00FF88', fontSize: 10, marginTop: 4 }, repRow: { borderTopColor: 'rgba(255,255,255,0.1)', borderTopWidth: 1, gap: 4, paddingVertical: 10 }, repName: { color: '#FFFF00', fontSize: 11, fontWeight: '900' }, repMetric: { color: 'rgba(255,255,255,0.7)', fontSize: 12 }, readiness: { color: '#FFFF00', fontSize: 36, fontWeight: '900' }, disclaimer: { color: '#FFB66D', fontSize: 11, marginTop: 12 }, warning: { color: '#FF8069', fontSize: 14, fontWeight: '800', lineHeight: 20, marginTop: 10 }, success: { color: '#00FF88', fontSize: 12 }, question: { borderTopColor: 'rgba(255,255,255,0.1)', borderTopWidth: 1, gap: 8, paddingTop: 12 }, result: { borderTopColor: 'rgba(255,255,255,0.15)', borderTopWidth: 1, gap: 8, marginTop: 8, paddingTop: 14 }, liveCard: { backgroundColor: 'rgba(7,21,31,0.88)', borderRadius: 18, padding: 18, gap: 14 }, recordActions: { flexDirection: 'row', gap: 10, marginTop: 'auto' },
});
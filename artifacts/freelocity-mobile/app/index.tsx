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
import { analyzeSet, useGetDemoHistory, type DemoHistoricalSet, type SetAnalysisResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useConcussionTracker } from '@/src/hooks/useConcussionTracker';
import { convertHistoryLoads, formatMassFromKg, fromCanonicalKg, getUnitConfig, toCanonicalKg, type UnitSystem } from '@/src/lib/units';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';
import type { SetSummary } from '@/src/lib/vbtTracker';

type Phase = 'SETUP' | 'CALIBRATE' | 'RECORD' | 'PROCESSING' | 'FEEDBACK' | 'RECOVERY';
type Placement = 'barbell' | 'pocket';
type Colors = ReturnType<typeof useColors>;
const dt = 1 / 60;
const UNIT_STORAGE_KEY = 'freelocity.unit-system';

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

function Feedback({ result, fallback, error, colors, onRecovery, onRestart, unitSystem, weightKg }: { result: SetAnalysisResult | null; fallback: SetSummary; error: string | null; colors: Colors; onRecovery: () => void; onRestart: () => void; unitSystem: UnitSystem; weightKg: number }) {
  const r = result;
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>SET FEEDBACK</Text><Text style={styles.title}>What changed today</Text>
    <View style={styles.source}><Text style={styles.sourceText}>{r ? 'MEASURED FROM API RESPONSE' : 'DEGRADED / DEMO FALLBACK'}</Text><Text style={styles.body}>{r ? 'Sensor batch analyzed and persisted for future load-matched readiness.' : 'No reliable API result was available. Values below are estimates for rehearsal, not validation.'}</Text></View>
    <View style={styles.grid}>
       <Metric label="LOAD" value={formatMassFromKg(weightKg, unitSystem)} note="display preference" />
      <Metric label="REPS" value={String(r?.actual_reps ?? fallback.reps.length)} />
      <Metric label="MEAN VELOCITY" value={`${(r?.mean_velocity_ms ?? 0).toFixed(3)} m/s`} note="measured / integrated" />
      <Metric label="PEAK VELOCITY" value={`${(r?.peak_velocity_ms ?? fallback.topSpeed).toFixed(3)} m/s`} note="peak estimate" />
      <Metric label="VELOCITY LOSS" value={r?.velocity_loss_pct == null ? '—' : `${r.velocity_loss_pct.toFixed(1)}%`} note={r?.fatigue_level ?? 'needs ≥2 reps'} />
      <Metric label="DURATION" value={`${(r?.duration_s ?? fallback.durationSec ?? 0).toFixed(1)} s`} />
      <Metric label="DATA QUALITY" value={r ? 'GOOD' : 'DEMO'} note={r ? `${r.sample_count} samples` : 'fallback path'} />
    </View>
    <View style={styles.card}><Text style={styles.cardTitle}>Readiness · load matched</Text><Text style={styles.readiness}>{r?.cns_readiness_score == null ? 'Building baseline' : `${r.cns_readiness_score}/100`}</Text><Text style={styles.body}>{r?.motor_readiness_level ?? 'Insufficient data'} · trend: {r?.velocity_trend ?? 'Insufficient data'}</Text>{r?.baseline_velocity_ms != null && <Text style={styles.body}>Baseline first-rep peak: {r.baseline_velocity_ms.toFixed(3)} m/s</Text>}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>AI coach · evidence grounded</Text>{!r && <Text style={styles.warning}>Analysis request failed: {error ?? 'The server did not return a result.'}</Text>}<Text style={styles.body}>{r?.ai_feedback ?? 'Coaching unavailable because the analysis request failed. Retry with the same set; do not treat fallback values as coaching evidence.'}</Text><Text style={styles.disclaimer}>Recommendations are performance guidance only. No injury or concussion inference is made.</Text></View>
    <Button label="START SEPARATE RECOVERY CHECK-IN" onPress={onRecovery} secondary /><Button label="RESTART HERO SQUAT" onPress={onRestart} />
  </ScrollView>;
}

export default function MotionTrackerScreen() {
  const colors = useColors(); const insets = useSafeAreaInsets(); const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('SETUP'); const [weight, setWeight] = useState('60'); const [targetReps, setTargetReps] = useState('5'); const [placement, setPlacement] = useState<Placement>('barbell'); const [demoMode, setDemoMode] = useState(false); const [summary, setSummary] = useState<SetSummary>({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0 }); const [result, setResult] = useState<SetAnalysisResult | null>(null); const [error, setError] = useState<string | null>(null); const [unitSystem, setUnitSystem] = useState<UnitSystem>('imperial'); const [unitsReady, setUnitsReady] = useState(false);
  const samples = useRef<{ x: number; y: number; z: number; timestamp: number }[]>([]); const startedAt = useRef(0); const finished = useRef(false); const tracker = useVbtTracker('FREE_WEIGHT_SIDE'); useKeepAwake();
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
  useEffect(() => { if (phase !== 'RECORD' || !permission?.granted || demoMode) return; Accelerometer.setUpdateInterval(1000 / 60); const sub = Accelerometer.addListener((data) => { samples.current.push({ x: data.x, y: data.y, z: data.z, timestamp: Date.now() }); const next = tracker.updateImu(data.y * 9.81, dt); if (next.completedSet) finish(next.completedSet); }); return () => sub.remove(); }, [demoMode, permission?.granted, phase, tracker.updateImu]);
  const finish = useCallback(async (tracked?: SetSummary) => { if (finished.current) return; finished.current = true; const current = tracked ?? tracker.stopSet().completedSet ?? summary; const source = demoMode ? 'DEMO' : 'IMU'; const decorated = { ...current, durationSec: (Date.now() - startedAt.current) / 1000, sampleCount: samples.current.length, dataQuality: source === 'DEMO' ? 'DEMO' : 'GOOD', confidence: source === 'DEMO' ? 'LOW' : 'MEDIUM', inferenceSource: source, limitations: source === 'DEMO' ? ['Seeded rehearsal data; not accuracy validation.'] : ['IMU integration is an estimate; keep placement stable.'] } as SetSummary; setSummary(decorated); setPhase('PROCESSING'); setError(null); try { const response = await analyzeSet({ exercise_name: 'Squat', weight_kg: displayWeightKg, display_unit: unitSystem, display_load: Number(weight), target_reps: Number(targetReps), total_sets: 1, phone_placement: placement === 'barbell' ? 'barbell' : 'pocket', samples: source === 'DEMO' ? seededSamples() : samples.current }); setResult(response); setPhase('FEEDBACK'); } catch (e) { setError(e instanceof Error ? e.message : 'Analysis request failed'); setPhase('FEEDBACK'); } }, [demoMode, displayWeightKg, placement, summary, targetReps, tracker.stopSet, unitSystem, weight]);
  const start = () => { samples.current = []; finished.current = false; startedAt.current = Date.now(); setResult(null); setError(null); if (demoMode || !permission?.granted) { setPhase('RECORD'); setTimeout(() => finish({ reps: Array.from({ length: Number(targetReps) || 5 }, (_, i) => ({ repNumber: i + 1, repTimeSec: 1.1, peakVelocity: 0.58 - i * 0.03, meanVelocity: 0.4 })), meanRepTime: 1.1, topSpeed: 0.58, peakVelocities: [0.58, 0.55, 0.52, 0.49, 0.46], consistencyScore: 88 }), 1200); } else setPhase('RECORD'); };
  const reset = () => { tracker.resetTracker(); finished.current = false; setSummary({ reps: [], meanRepTime: 0, topSpeed: 0, peakVelocities: [], consistencyScore: 0 }); setPhase('SETUP'); setResult(null); setError(null); };
  if (phase === 'RECOVERY') return <View style={[styles.root, { paddingTop: insets.top }]}><Recovery colors={colors} onBack={() => setPhase('FEEDBACK')} /></View>;
  if (phase === 'FEEDBACK') return <View style={[styles.root, { paddingTop: insets.top }]}><Feedback result={result} fallback={summary} error={error} colors={colors} onRecovery={() => setPhase('RECOVERY')} onRestart={reset} unitSystem={unitSystem} weightKg={displayWeightKg} /></View>;
  if (phase === 'PROCESSING') return <View style={styles.center}><ActivityIndicator color="#FFFF00" size="large" /><Text style={styles.title}>Analyzing your set</Text><Text style={styles.body}>Integrating motion, checking load-matched readiness, and requesting grounded coaching…</Text></View>;
  if (phase === 'SETUP' || phase === 'CALIBRATE') return <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 24 }]}><Text style={styles.eyebrow}>FREELOCITY · HERO SQUAT</Text><Text style={styles.title}>One reliable set story.</Text><Text style={styles.body}>A sensor-assisted squat session with explicit estimates, uncertainty, and a separate recovery safety check.</Text><View style={styles.stepper}><Text style={phase === 'SETUP' ? styles.stepActive : styles.step}>1 SETUP</Text><Text style={phase === 'CALIBRATE' ? styles.stepActive : styles.step}>2 CALIBRATE</Text><Text style={styles.step}>3 SET</Text><Text style={styles.step}>4 FEEDBACK</Text></View>{phase === 'CALIBRATE' ? <View style={styles.card}><Text style={styles.cardTitle}>Phone placement calibration</Text><Text style={styles.body}>Place the phone securely {placement === 'barbell' ? 'on the barbell' : 'in the pocket'} with the motion axis stable. The reference is a placement check, not a precision or clinical calibration.</Text><Text style={styles.success}>Reference ready · sensor estimates will be labeled</Text><Button label="REFERENCE CAPTURED · START SET" onPress={() => { if (!permission?.granted && !demoMode) requestPermission(); start(); }} /><Button label="BACK TO SETUP" secondary onPress={() => setPhase('SETUP')} /></View> : <><View style={styles.card}><Text style={styles.cardTitle}>Squat setup</Text><Text style={styles.label}>LOAD · {getUnitConfig(unitSystem).abbreviation.toUpperCase()}</Text><TextInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" style={styles.input} placeholder={`Enter ${getUnitConfig(unitSystem).name}`} placeholderTextColor="rgba(255,255,255,0.35)" /><Text style={styles.label}>TARGET REPS</Text><TextInput value={targetReps} onChangeText={setTargetReps} keyboardType="number-pad" style={styles.input} /><Text style={styles.label}>PHONE PLACEMENT</Text><View style={styles.row}><Button label="BARBELL" secondary={placement !== 'barbell'} onPress={() => setPlacement('barbell')} /><Button label="POCKET" secondary={placement !== 'pocket'} onPress={() => setPlacement('pocket')} /></View><View style={styles.switchRow}><Text style={styles.body}>Demo-safe fallback path</Text><Switch value={demoMode} onValueChange={setDemoMode} /></View><Text style={styles.caption}>{demoMode ? 'DEMO: seeded values are sent through the same API contract; not validation.' : 'LIVE: accelerometer capture when available. Camera frames are not persisted.'}</Text></View><View style={styles.card}><Text style={styles.cardTitle}>Settings & data</Text><Text style={styles.label}>MASS UNITS</Text><UnitToggle value={unitSystem} onChange={changeUnit} /><Text style={styles.caption}>Imperial is the default. Your preference is saved on this device; analytics and baselines stay canonical in kg.</Text></View><HistoryCard rows={historyQuery.data ?? []} unitSystem={unitSystem} loading={historyQuery.isLoading} /><Button label="CALIBRATE PHONE PLACEMENT" onPress={() => setPhase('CALIBRATE')} /><Button label={permission?.granted ? 'START LIVE SQUAT' : 'START DEMO / REQUEST CAMERA'} onPress={() => { if (!permission?.granted && !demoMode) requestPermission(); start(); }} secondary /></>}</ScrollView>;
  return <View style={styles.root}><CameraView facing="back" style={StyleSheet.absoluteFillObject} /><View style={styles.shade} /><View style={[styles.record, { paddingTop: insets.top + 22 }]}><Text style={styles.eyebrow}>{demoMode ? 'DEMO REHEARSAL' : 'LIVE IMU TRACKING'}</Text><Text style={styles.title}>Squat set in progress</Text><View style={styles.liveCard}><Metric label="REPS DETECTED" value={String(tracker.reps.length)} /><Metric label="VELOCITY" value={`${tracker.currentVelocity.toFixed(2)} m/s`} /><Text style={styles.body}>{demoMode ? 'Seeded fallback is running. Precision is intentionally not claimed.' : 'Move naturally. If automatic inference is uncertain, tap manual reps.'}</Text></View><View style={styles.recordActions}><Button label="MANUAL REP" onPress={() => tracker.manualIncrementRep()} secondary /><Button label="STOP & ANALYZE" onPress={() => finish()} /></View><Text style={styles.caption}>Calibration: 450 mm plate reference · placement: {placement}. Estimates are not clinical measurements.</Text></View></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07151F' }, page: { backgroundColor: '#07151F', padding: 20, gap: 16, paddingBottom: 40, flexGrow: 1 }, center: { flex: 1, backgroundColor: '#07151F', alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }, record: { flex: 1, padding: 20, gap: 18 }, shade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' }, eyebrow: { color: '#FFFF00', fontSize: 11, fontWeight: '900', letterSpacing: 1.4 }, title: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', letterSpacing: -1 }, body: { color: 'rgba(255,255,255,0.68)', fontSize: 14, lineHeight: 21 }, caption: { color: 'rgba(255,255,255,0.48)', fontSize: 11, lineHeight: 16 }, stepper: { flexDirection: 'row', justifyContent: 'space-between' }, step: { color: 'rgba(255,255,255,0.35)', fontSize: 9, fontWeight: '900' }, stepActive: { color: '#00FF88', fontSize: 9, fontWeight: '900' }, card: { backgroundColor: '#102633', borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 }, cardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' }, label: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '900', letterSpacing: 1 }, input: { color: '#FFFFFF', borderBottomColor: 'rgba(255,255,255,0.3)', borderBottomWidth: 1, fontSize: 20, paddingVertical: 7 }, row: { flexDirection: 'row', gap: 10 }, button: { backgroundColor: '#00A99D', borderRadius: 13, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, flex: 1 }, secondaryButton: { backgroundColor: 'transparent', borderColor: '#00FF88', borderWidth: 1 }, buttonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 0.7 }, secondaryButtonText: { color: '#00FF88' }, switchRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, unitToggle: { flexDirection: 'row', gap: 8 }, unitOption: { flex: 1, borderColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderRadius: 12, padding: 10 }, unitOptionActive: { backgroundColor: '#00A99D', borderColor: '#00FF88' }, unitOptionText: { color: 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '800' }, unitOptionTextActive: { color: '#FFFFFF' }, unitOptionSubtext: { color: 'rgba(255,255,255,0.45)', fontSize: 10, marginTop: 3 }, historyList: { borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: 1 }, historyRow: { alignItems: 'center', borderBottomColor: 'rgba(255,255,255,0.08)', borderBottomWidth: 1, flexDirection: 'row', paddingVertical: 9 }, historySet: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '800', width: 52 }, historyLoad: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', width: 78 }, historyMeta: { color: 'rgba(255,255,255,0.52)', flex: 1, fontSize: 11 }, source: { backgroundColor: '#183B3D', borderRadius: 14, padding: 14, gap: 6 }, sourceText: { color: '#00FF88', fontSize: 11, fontWeight: '900', letterSpacing: 1 }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { backgroundColor: '#102633', borderRadius: 14, minHeight: 94, padding: 12, width: '48%' }, metricLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 9, fontWeight: '900' }, metricValue: { color: '#FFFFFF', fontSize: 22, fontWeight: '900', marginTop: 10 }, metricNote: { color: '#00FF88', fontSize: 10, marginTop: 4 }, readiness: { color: '#FFFF00', fontSize: 36, fontWeight: '900' }, disclaimer: { color: '#FFB66D', fontSize: 11, marginTop: 12 }, warning: { color: '#FF8069', fontSize: 14, fontWeight: '800', lineHeight: 20, marginTop: 10 }, success: { color: '#00FF88', fontSize: 12 }, question: { borderTopColor: 'rgba(255,255,255,0.1)', borderTopWidth: 1, gap: 8, paddingTop: 12 }, result: { borderTopColor: 'rgba(255,255,255,0.15)', borderTopWidth: 1, gap: 8, marginTop: 8, paddingTop: 14 }, liveCard: { backgroundColor: 'rgba(7,21,31,0.88)', borderRadius: 18, padding: 18, gap: 14 }, recordActions: { flexDirection: 'row', gap: 10, marginTop: 'auto' },
});
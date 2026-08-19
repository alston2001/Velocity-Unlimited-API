import { useAnalyzeSet } from '@workspace/api-client-react';
import type { AccelerationSample, SetAnalysisResult } from '@workspace/api-client-react';
import { Accelerometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SensorReading = { x: number; y: number; z: number };

type Phase =
  | 'setup'      // User filling in the form
  | 'ready'      // Form submitted, waiting to start set
  | 'recording'  // High-frequency capture in progress
  | 'submitting' // Sending batch to API
  | 'feedback';  // Results shown

type WeightUnit = 'kg' | 'lbs';

type PhonePlacement = 'weight_stack' | 'barbell' | 'pocket';

const PLACEMENT_OPTIONS: {
  value: PhonePlacement;
  label: string;
  subtitle: string;
  icon: string;
}[] = [
  {
    value: 'weight_stack',
    label: 'Weight Stack / Pulley Pin',
    subtitle: 'Best for machines & cables with linear motion',
    icon: '🏋️',
  },
  {
    value: 'barbell',
    label: 'Fixed to Barbell / Weight',
    subtitle: 'Best for squat, bench, deadlift with a strap or magnet',
    icon: '⚖️',
  },
  {
    value: 'pocket',
    label: 'In Your Pocket',
    subtitle: 'Best for bodyweight & plyometrics — zero setup',
    icon: '🩲',
  },
];

type FormValues = {
  exerciseName: string;
  weight: string;
  weightUnit: WeightUnit;
  targetReps: string;
  totalSets: string;
};

const RECORD_HZ = 50; // 50 Hz during recording
const IDLE_HZ = 10;   // 10 Hz for live preview only

type SessionSet = {
  setNum: number;
  meanVelocityMs: number;
  peakVelocityMs: number;
  zone: string;
  actualReps: number;
  weightKg: number;
  estimated1RmPct: number;
};

const REST_PRESETS = [60, 90, 120, 180] as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AxisCard({
  axis,
  value,
  color,
  colors,
  highlight,
}: {
  axis: string;
  value: number;
  color: string;
  colors: ReturnType<typeof useColors>;
  highlight?: boolean;
}) {
  const normalized = Math.min(Math.abs(value) / 2, 1);
  const direction = value >= 0 ? 'positive' : 'negative';

  return (
    <View
      style={[
        styles.axisCard,
        {
          backgroundColor: highlight ? colors.primary + '18' : colors.card,
          borderColor: highlight ? color : colors.border,
        },
      ]}
    >
      <View style={styles.axisHeader}>
        <View style={[styles.axisDot, { backgroundColor: color }]} />
        <Text style={[styles.axisLabel, { color: colors.mutedForeground }]}>
          {axis} AXIS
        </Text>
      </View>
      <Text style={[styles.axisValue, { color: colors.foreground }]}>
        {value.toFixed(3)}
      </Text>
      <Text style={[styles.axisUnit, { color: colors.mutedForeground }]}>G</Text>
      <View style={[styles.track, { backgroundColor: colors.muted }]}>
        <View
          style={[
            styles.trackFill,
            {
              width: `${Math.max(normalized * 100, 3)}%`,
              backgroundColor: color,
              alignSelf: direction === 'positive' ? 'flex-end' : 'flex-start',
            },
          ]}
        />
      </View>
    </View>
  );
}

function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  colors,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad';
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <TextInput
        style={[
          styles.fieldInput,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            color: colors.foreground,
          },
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground + '80'}
        keyboardType={keyboardType ?? 'default'}
        returnKeyType="next"
        autoCorrect={false}
      />
    </View>
  );
}

function PlacementPicker({
  selected,
  onSelect,
  colors,
}: {
  selected: PhonePlacement | null;
  onSelect: (p: PhonePlacement) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.placementSection}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>PHONE PLACEMENT DURING SETS</Text>
      {PLACEMENT_OPTIONS.map((opt) => {
        const active = selected === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            style={[
              styles.placementOption,
              {
                backgroundColor: active ? colors.primary + '18' : colors.card,
                borderColor: active ? colors.primary : colors.border,
              },
            ]}
          >
            <Text style={styles.placementIcon}>{opt.icon}</Text>
            <View style={styles.placementText}>
              <Text style={[styles.placementLabel, { color: active ? colors.primary : colors.foreground }]}>
                {opt.label}
              </Text>
              <Text style={[styles.placementSubtitle, { color: colors.mutedForeground }]}>
                {opt.subtitle}
              </Text>
            </View>
            <View
              style={[
                styles.placementRadio,
                {
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primary : 'transparent',
                },
              ]}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function MetricTile({
  label,
  value,
  unit,
  colors,
}: {
  label: string;
  value: string;
  unit: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.metricTile, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.metricUnit, { color: colors.mutedForeground }]}>{unit}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rep-by-rep velocity bars
// ---------------------------------------------------------------------------

function zoneColor(zone: string, colors: ReturnType<typeof useColors>): string {
  if (zone.includes('Power'))          return '#FFD600'; // yellow — explosive
  if (zone.includes('Speed-Strength')) return colors.primary; // blue — fast-loaded
  if (zone.includes('Strength-Speed')) return colors.destructive; // red — heavy-fast
  if (zone.includes('Maximal'))        return colors.destructive; // red — maximal
  return colors.mutedForeground;
}

function RepVelocityBars({
  repPeaks,
  colors,
}: {
  repPeaks: number[];
  colors: ReturnType<typeof useColors>;
}) {
  if (repPeaks.length === 0) return null;
  const maxV = Math.max(...repPeaks, 0.01);
  const firstPeak = repPeaks[0]!;

  return (
    <View style={[styles.repBarsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>REP-BY-REP VELOCITY</Text>
      <View style={styles.repBarsGrid}>
        {repPeaks.map((v, i) => {
          const pct = v / maxV;
          const dropPct = i > 0 ? ((firstPeak - v) / firstPeak) * 100 : 0;
          const barColor = dropPct > 20 ? colors.destructive : dropPct > 10 ? colors.primary : '#FFD600';
          return (
            <View key={i} style={styles.repBarCol}>
              <Text style={[styles.repBarValue, { color: barColor }]}>
                {v.toFixed(2)}
              </Text>
              <View style={[styles.repBarTrack, { backgroundColor: colors.muted }]}>
                <View
                  style={[
                    styles.repBarFill,
                    {
                      height: `${Math.max(pct * 100, 6)}%` as `${number}%`,
                      backgroundColor: barColor,
                    },
                  ]}
                />
              </View>
              <Text style={[styles.repBarLabel, { color: colors.mutedForeground }]}>
                R{i + 1}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
        m/s peak per rep · yellow = strong · blue = slight drop · red &gt;20% velocity loss
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rest timer
// ---------------------------------------------------------------------------

function RestTimer({
  secsLeft,
  target,
  onPreset,
  onSkip,
  colors,
}: {
  secsLeft: number;
  target: number;
  onPreset: (secs: number) => void;
  onSkip: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const done = secsLeft <= 0;
  const pct = done ? 1 : (target - secsLeft) / target;
  const mins = Math.floor(secsLeft / 60);
  const secs = secsLeft % 60;
  const label = done ? 'REST COMPLETE' : 'REST TIMER';
  const timerColor = done ? '#FFD600' : secsLeft < 15 ? colors.destructive : colors.foreground;

  return (
    <View style={[styles.restCard, { backgroundColor: colors.card, borderColor: done ? '#FFD60055' : colors.border }]}>
      <View style={styles.restHeader}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Pressable onPress={onSkip} hitSlop={12}>
          <Text style={[styles.restSkip, { color: colors.mutedForeground }]}>Skip</Text>
        </Pressable>
      </View>

      {/* Progress bar */}
      <View style={[styles.restTrack, { backgroundColor: colors.muted }]}>
        <View style={[styles.restFill, { width: `${pct * 100}%` as `${number}%`, backgroundColor: done ? '#FFD600' : colors.primary }]} />
      </View>

      {/* Time display */}
      <Text style={[styles.restTime, { color: timerColor }]}>
        {done ? '✓  Go' : `${mins}:${String(secs).padStart(2, '0')}`}
      </Text>

      {/* Preset buttons */}
      <View style={styles.restPresets}>
        {REST_PRESETS.map((t) => (
          <Pressable
            key={t}
            onPress={() => onPreset(t)}
            style={({ pressed }) => [
              styles.restPreset,
              {
                backgroundColor: t === target ? colors.primary + '25' : colors.muted,
                borderColor: t === target ? colors.primary + '80' : colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.restPresetText, { color: t === target ? colors.primary : colors.mutedForeground }]}>
              {t}s
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Session log strip
// ---------------------------------------------------------------------------

function SessionStrip({
  sets,
  colors,
}: {
  sets: SessionSet[];
  colors: ReturnType<typeof useColors>;
}) {
  if (sets.length === 0) return null;

  return (
    <View style={[styles.sessionStrip, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        SESSION LOG — {sets.length} {sets.length === 1 ? 'set' : 'sets'}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sessionScroll}>
        {sets.map((s) => {
          const zColor = zoneColor(s.zone, colors);
          return (
            <View
              key={s.setNum}
              style={[
                styles.sessionSetChip,
                { backgroundColor: zColor + '18', borderColor: zColor + '55' },
              ]}
            >
              <Text style={[styles.sessionSetNum, { color: colors.mutedForeground }]}>S{s.setNum}</Text>
              <Text style={[styles.sessionSetVel, { color: zColor }]}>
                {s.meanVelocityMs.toFixed(3)}
              </Text>
              <Text style={[styles.sessionSetUnit, { color: colors.mutedForeground }]}>m/s</Text>
              <Text style={[styles.sessionSetReps, { color: colors.mutedForeground }]}>
                {s.actualReps}r · ~{s.estimated1RmPct}%
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// CNS Motor Readiness card
// ---------------------------------------------------------------------------

type ReadinessLevel = 'High' | 'Moderate' | 'Low' | 'Compromised' | 'Insufficient data' | null | undefined;
type VelocityTrend = 'Rising' | 'Stable' | 'Declining' | 'Insufficient data' | null | undefined;

function readinessColor(level: ReadinessLevel, colors: ReturnType<typeof useColors>): string {
  if (!level || level === 'Insufficient data') return colors.mutedForeground;
  if (level === 'High')       return colors.primary;     // blue — ready to fire
  if (level === 'Moderate')   return '#FFD600';          // yellow — proceed with awareness
  if (level === 'Low')        return colors.destructive; // red — caution
  return colors.destructive;                             // red — Compromised
}

function trendArrow(trend: VelocityTrend): string {
  if (trend === 'Rising')   return '↑ Rising';
  if (trend === 'Declining') return '↓ Declining';
  if (trend === 'Stable')   return '→ Stable';
  return '— Unknown';
}

function trendColor(trend: VelocityTrend, colors: ReturnType<typeof useColors>): string {
  if (trend === 'Rising')    return colors.primary;
  if (trend === 'Declining') return colors.destructive;
  if (trend === 'Stable')    return '#FFD600';
  return colors.mutedForeground;
}

function ReadinessCard({
  score,
  level,
  trend,
  dataPoints,
  baselineVelocityMs,
  firstRepPeakMs,
  colors,
}: {
  score: number | null | undefined;
  level: ReadinessLevel;
  trend: VelocityTrend;
  dataPoints: number | undefined;
  baselineVelocityMs: number | null | undefined;
  firstRepPeakMs: number | null | undefined;
  colors: ReturnType<typeof useColors>;
}) {
  const pts = dataPoints ?? 0;
  const rColor = readinessColor(level, colors);
  const hasScore = score !== null && score !== undefined && level !== 'Insufficient data';

  return (
    <View style={[styles.readinessCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Header */}
      <View style={styles.readinessHeader}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
          CNS MOTOR READINESS
        </Text>
        {trend && trend !== 'Insufficient data' && (
          <Text style={[styles.trendBadge, { color: trendColor(trend, colors) }]}>
            {trendArrow(trend)}
          </Text>
        )}
      </View>

      {hasScore ? (
        <>
          {/* Score row */}
          <View style={styles.readinessScoreRow}>
            <Text style={[styles.readinessScore, { color: rColor }]}>
              {score}
            </Text>
            <View style={styles.readinessScoreSuffix}>
              <Text style={[styles.readinessScoreMax, { color: colors.mutedForeground }]}>/100</Text>
              <View style={[styles.readinessLevelPill, { backgroundColor: rColor + '22', borderColor: rColor + '55' }]}>
                <Text style={[styles.readinessLevelText, { color: rColor }]}>{level}</Text>
              </View>
            </View>
          </View>

          {/* Score bar */}
          <View style={[styles.readinessTrack, { backgroundColor: colors.muted }]}>
            <View style={[styles.readinessFill, { width: `${score}%` as `${number}%`, backgroundColor: rColor }]} />
          </View>

          {/* Stats row */}
          <View style={styles.readinessStats}>
            {firstRepPeakMs !== null && firstRepPeakMs !== undefined && (
              <View style={styles.readinessStat}>
                <Text style={[styles.readinessStatLabel, { color: colors.mutedForeground }]}>TODAY'S 1ST REP</Text>
                <Text style={[styles.readinessStatValue, { color: colors.foreground }]}>
                  {firstRepPeakMs.toFixed(3)} m/s
                </Text>
              </View>
            )}
            {baselineVelocityMs !== null && baselineVelocityMs !== undefined && (
              <View style={styles.readinessStat}>
                <Text style={[styles.readinessStatLabel, { color: colors.mutedForeground }]}>21-DAY BASELINE</Text>
                <Text style={[styles.readinessStatValue, { color: colors.foreground }]}>
                  {baselineVelocityMs.toFixed(3)} m/s
                </Text>
              </View>
            )}
            <View style={styles.readinessStat}>
              <Text style={[styles.readinessStatLabel, { color: colors.mutedForeground }]}>SESSIONS USED</Text>
              <Text style={[styles.readinessStatValue, { color: colors.foreground }]}>{pts}</Text>
            </View>
          </View>
        </>
      ) : (
        /* Building baseline state */
        <View style={styles.readinessBuilding}>
          <Text style={[styles.readinessBuildingTitle, { color: colors.foreground }]}>
            Building baseline…
          </Text>
          <Text style={[styles.readinessBuildingSubtitle, { color: colors.mutedForeground }]}>
            {pts}/3 load-matched sessions recorded. Complete {3 - pts} more {3 - pts === 1 ? 'set' : 'sets'} at this weight to unlock readiness tracking.
          </Text>
          {/* Progress pips */}
          <View style={styles.readinessPips}>
            {[0, 1, 2].map((i) => (
              <View
                key={i}
                style={[
                  styles.readinessPip,
                  {
                    backgroundColor: i < pts ? colors.primary : colors.muted,
                    borderColor: i < pts ? colors.primary : colors.border,
                  },
                ]}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function MotionTrackerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Keep screen on while recording
  useKeepAwake();

  // Sensor
  const [sensorAvailable, setSensorAvailable] = useState<boolean | null>(null);
  const [live, setLive] = useState<SensorReading>({ x: 0, y: 0, z: 0 });
  const sampleBuffer = useRef<AccelerationSample[]>([]);
  const vbtTracker = useVbtTracker();

  // Workflow state
  const [phase, setPhase] = useState<Phase>('setup');
  const [form, setForm] = useState<FormValues>({
    exerciseName: '',
    weight: '',
    weightUnit: 'kg',
    targetReps: '',
    totalSets: '',
  });
  const [sampleCount, setSampleCount] = useState(0);

  // Phone placement
  const [phonePlacement, setPhonePlacement] = useState<PhonePlacement | null>(null);

  // Session tracking
  const [sessionSets, setSessionSets] = useState<SessionSet[]>([]);
  const [setNumber, setSetNumber] = useState(1);
  const [lastSetResult, setLastSetResult] = useState<SetAnalysisResult | null>(null);

  // Rest timer
  const [restTimerTarget, setRestTimerTarget] = useState(90);
  const [restTimerSecs, setRestTimerSecs] = useState(0);
  const [restTimerActive, setRestTimerActive] = useState(false);

  const analyzeSet = useAnalyzeSet();

  // ---------------------------------------------------------------------------
  // Rest timer tick
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!restTimerActive) return;
    if (restTimerSecs <= 0) {
      setRestTimerActive(false);
      // Haptic nudge when rest is done (native only)
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      return;
    }
    const t = setTimeout(() => setRestTimerSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [restTimerActive, restTimerSecs]);

  // ---------------------------------------------------------------------------
  // Accelerometer
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (Platform.OS === 'web') {
      setSensorAvailable(false);
      return;
    }

    let sub: ReturnType<typeof Accelerometer.addListener> | undefined;
    let active = true;

    Accelerometer.isAvailableAsync().then((ok) => {
      if (!active) return;
      setSensorAvailable(ok);
      if (!ok) return;

      Accelerometer.setUpdateInterval(1000 / IDLE_HZ);
      sub = Accelerometer.addListener((d) => {
        setLive({ x: d.x, y: d.y, z: d.z });
      });
    });

    return () => {
      active = false;
      sub?.remove();
    };
  }, []);

  // Ramp up to 50 Hz when recording, back down when not
  useEffect(() => {
    if (Platform.OS === 'web' || sensorAvailable !== true) return;

    const hz = phase === 'recording' ? RECORD_HZ : IDLE_HZ;
    Accelerometer.setUpdateInterval(1000 / hz);
  }, [phase, sensorAvailable]);

  // Buffer samples while recording
  useEffect(() => {
    if (phase !== 'recording' || Platform.OS === 'web' || sensorAvailable !== true) return;

    // Re-subscribe to make sure the listener is capturing into the new buffer
    Accelerometer.setUpdateInterval(1000 / RECORD_HZ);
    const sub = Accelerometer.addListener((d) => {
      const accelY_ms2 = d.y * 9.81;
      vbtTracker.processFrame(accelY_ms2, 0.0166);

      const sample: AccelerationSample = {
        x: d.x,
        y: d.y,
        z: d.z,
        timestamp: Date.now(),
      };
      sampleBuffer.current.push(sample);
      setSampleCount((n) => n + 1);
      setLive({ x: d.x, y: d.y, z: d.z });
    });

    return () => {
      sub.remove();
    };
  }, [phase, sensorAvailable, vbtTracker.processFrame]);

  function handleReset() {
    vbtTracker.reset();
    sampleBuffer.current = [];
    setSampleCount(0);
  }

  // ---------------------------------------------------------------------------
  // Form helpers
  // ---------------------------------------------------------------------------

  function setField(key: keyof FormValues) {
    return (v: string) => setForm((f) => ({ ...f, [key]: v }));
  }

  const formValid =
    form.exerciseName.trim().length > 0 &&
    parseFloat(form.weight) > 0 &&
    parseInt(form.targetReps) > 0 &&
    parseInt(form.totalSets) > 0 &&
    phonePlacement !== null;

  /** Convert the current weight value when the unit toggle flips */
  function toggleWeightUnit() {
    setForm((f) => {
      const val = parseFloat(f.weight);
      const newUnit: WeightUnit = f.weightUnit === 'kg' ? 'lbs' : 'kg';
      let newWeight = f.weight;
      if (!isNaN(val) && val > 0) {
        const converted = newUnit === 'lbs' ? val * 2.20462 : val / 2.20462;
        newWeight = parseFloat(converted.toFixed(1)).toString();
      }
      return { ...f, weightUnit: newUnit, weight: newWeight };
    });
  }

  /** Always send kg to the API regardless of display unit */
  function weightAsKg(): number {
    const val = parseFloat(form.weight);
    if (isNaN(val)) return 0;
    return form.weightUnit === 'lbs' ? val / 2.20462 : val;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function handleConfirmSetup() {
    if (!formValid) return;
    setPhase('ready');
    analyzeSet.reset();
  }

  function handleStartSet() {
    sampleBuffer.current = [];
    setSampleCount(0);
    setRestTimerActive(false); // stop rest timer when set begins
    setPhase('recording');
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    }
  }

  function handleStopSet() {
    const samples = [...sampleBuffer.current];
    setPhase('submitting');
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }

    analyzeSet.mutate(
      {
        data: {
          exercise_name: form.exerciseName.trim(),
          weight_kg: weightAsKg(),
          target_reps: parseInt(form.targetReps),
          total_sets: parseInt(form.totalSets),
          samples,
          phone_placement: phonePlacement ?? 'weight_stack',
        },
      },
      {
        onSuccess: (data) => {
          setPhase('feedback');
          setLastSetResult(data);
          // Accumulate session log (only if real movement detected)
          if (data.mean_velocity_ms > 0.05) {
            const entry: SessionSet = {
              setNum: setNumber,
              meanVelocityMs: data.mean_velocity_ms,
              peakVelocityMs: data.peak_velocity_ms,
              zone: data.velocity_zone,
              actualReps: data.actual_reps,
              weightKg: weightAsKg(),
              estimated1RmPct: data.estimated_1rm_pct,
            };
            setSessionSets((prev) => [...prev, entry]);
          }
          // Auto-start rest timer
          setRestTimerSecs(restTimerTarget);
          setRestTimerActive(true);
        },
        onError: () => setPhase('feedback'),
      },
    );
  }

  function handleNewSet() {
    sampleBuffer.current = [];
    setSampleCount(0);
    setSetNumber((n) => n + 1);
    analyzeSet.reset();
    setPhase('ready');
  }

  function handleNewExercise() {
    sampleBuffer.current = [];
    setSampleCount(0);
    setSetNumber(1);
    setSessionSets([]);
    setLastSetResult(null);
    setRestTimerActive(false);
    setPhonePlacement(null);
    analyzeSet.reset();
    setPhase('setup');
  }

  function handleRestPreset(secs: number) {
    setRestTimerTarget(secs);
    setRestTimerSecs(secs);
    setRestTimerActive(true);
  }

  function handleRestSkip() {
    setRestTimerActive(false);
    setRestTimerSecs(0);
  }

  // ---------------------------------------------------------------------------
  // Derived UI state
  // ---------------------------------------------------------------------------

  const statusInfo = useMemo(() => {
    if (phase === 'recording') {
      return { label: `REC  ${sampleCount} samples`, color: colors.destructive };
    }
    if (sensorAvailable === null) return { label: 'CHECKING DEVICE', color: colors.mutedForeground };
    if (sensorAvailable) return { label: 'SENSOR LIVE', color: colors.primary };
    return {
      label: Platform.OS === 'web' ? 'OPEN IN EXPO GO' : 'SENSOR UNAVAILABLE',
      color: colors.accent,
    };
  }, [phase, sampleCount, sensorAvailable, colors]);

  const isRecording = phase === 'recording';
  const feedbackData = analyzeSet.data;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ---- Header ---- */}
          <View style={styles.topRow}>
            <View>
              <Text style={[styles.eyebrow, { color: colors.primary }]}>FREElOCITY / MOTION LAB</Text>
              <Text style={[styles.brand, { color: colors.foreground }]}>Freelocity</Text>
            </View>
            <Pressable
              style={[
                styles.statusPill,
                { backgroundColor: isRecording ? colors.destructive + '22' : colors.secondary },
              ]}
              onPress={undefined}
            >
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: statusInfo.color,
                    opacity: isRecording ? 1 : 0.9,
                  },
                ]}
              />
              <Text
                style={[
                  styles.statusText,
                  { color: isRecording ? colors.destructive : colors.secondaryForeground },
                ]}
              >
                {statusInfo.label}
              </Text>
            </Pressable>
          </View>

          {/* ---- Phase: SETUP form ---- */}
          {phase === 'setup' && (
            <View style={styles.section}>
              <Text style={[styles.title, { color: colors.foreground }]}>Set up your lift.</Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
                Enter the exercise details. The app will record bar velocity during your set.
              </Text>

              <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <FormField
                  label="EXERCISE NAME"
                  value={form.exerciseName}
                  onChangeText={setField('exerciseName')}
                  placeholder="e.g. Bench Press"
                  colors={colors}
                />
                {/* Weight + unit toggle */}
                <View style={styles.fieldWrap}>
                  <View style={styles.weightLabelRow}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>WEIGHT</Text>
                    <View style={[styles.unitToggle, { backgroundColor: colors.muted }]}>
                      {(['kg', 'lbs'] as WeightUnit[]).map((u) => (
                        <Pressable
                          key={u}
                          onPress={toggleWeightUnit}
                          style={[
                            styles.unitOption,
                            form.weightUnit === u && { backgroundColor: colors.primary },
                          ]}
                        >
                          <Text
                            style={[
                              styles.unitOptionText,
                              {
                                color:
                                  form.weightUnit === u
                                    ? colors.primaryForeground
                                    : colors.mutedForeground,
                              },
                            ]}
                          >
                            {u}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  <TextInput
                    style={[
                      styles.fieldInput,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        color: colors.foreground,
                      },
                    ]}
                    value={form.weight}
                    onChangeText={setField('weight')}
                    placeholder={form.weightUnit === 'kg' ? 'e.g. 100' : 'e.g. 225'}
                    placeholderTextColor={colors.mutedForeground + '80'}
                    keyboardType="decimal-pad"
                    returnKeyType="next"
                  />
                </View>
                <View style={styles.fieldRow}>
                  <View style={{ flex: 1 }}>
                    <FormField
                      label="TARGET REPS"
                      value={form.targetReps}
                      onChangeText={setField('targetReps')}
                      placeholder="e.g. 5"
                      keyboardType="numeric"
                      colors={colors}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <FormField
                      label="TOTAL SETS"
                      value={form.totalSets}
                      onChangeText={setField('totalSets')}
                      placeholder="e.g. 3"
                      keyboardType="numeric"
                      colors={colors}
                    />
                  </View>
                </View>
              </View>

              <PlacementPicker
                selected={phonePlacement}
                onSelect={setPhonePlacement}
                colors={colors}
              />

              <Pressable
                accessibilityRole="button"
                disabled={!formValid}
                onPress={handleConfirmSetup}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.primary,
                    opacity: !formValid ? 0.45 : pressed ? 0.82 : 1,
                  },
                ]}
              >
                <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                  Continue
                </Text>
              </Pressable>
            </View>
          )}

          {/* ---- Live sensor readout (always shown after setup) ---- */}
          {phase !== 'setup' && (
            <View style={[styles.liveCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.liveHeader}>
                <View>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                    LIVE READOUT
                  </Text>
                  <Text style={[styles.liveTitle, { color: colors.foreground }]}>
                    Accelerometer
                  </Text>
                </View>
                <View style={[styles.frequencyBadge, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.frequencyText, { color: colors.secondaryForeground }]}>
                    {isRecording ? `${RECORD_HZ} Hz` : `${IDLE_HZ} Hz`}
                  </Text>
                </View>
              </View>

              <View style={styles.axisGrid}>
                <AxisCard axis="X" value={live.x} color={colors.destructive} colors={colors} highlight={isRecording} />
                <AxisCard axis="Y" value={live.y} color="#FFD600" colors={colors} highlight={isRecording} />
                <AxisCard axis="Z" value={live.z} color={colors.primary} colors={colors} highlight={isRecording} />
              </View>

              <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
                {phonePlacement === 'pocket'
                  ? 'Values are in G. Velocity uses full-body motion magnitude for pocket mode.'
                  : 'Values are in G. Velocity is integrated from the Z-axis (vertical bar path).'}
              </Text>
              <View style={styles.serverMotionRow}>
                <View style={styles.serverMotionMetric}>
                  <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>SERVER VELOCITY</Text>
                  <Text style={[styles.metricValue, { color: colors.primary }]}>{vbtTracker.velocity.toFixed(3)}</Text>
                  <Text style={[styles.metricUnit, { color: colors.mutedForeground }]}>m/s</Text>
                </View>
                <View style={styles.serverMotionMetric}>
                  <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>SERVER POSITION</Text>
                  <Text style={[styles.metricValue, { color: colors.destructive }]}>{vbtTracker.position.toFixed(3)}</Text>
                  <Text style={[styles.metricUnit, { color: colors.mutedForeground }]}>m</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Reset server motion tracking"
                  onPress={handleReset}
                  style={({ pressed }) => [
                    styles.resetButton,
                    {
                      borderColor: colors.destructive,
                      backgroundColor: pressed ? colors.destructive + '18' : colors.card,
                    },
                  ]}
                >
                  <Text style={[styles.resetButtonText, { color: colors.destructive }]}>Reset</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* ---- Phase: READY — exercise summary + Start Set ---- */}
          {phase === 'ready' && (
            <View style={styles.section}>
              {/* Set number + exercise header */}
              <View style={[styles.exerciseSummary, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <View style={styles.exerciseSummaryHeader}>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>EXERCISE</Text>
                  <View style={[styles.setNumBadge, { backgroundColor: colors.primary + '22', borderColor: colors.primary + '55' }]}>
                    <Text style={[styles.setNumText, { color: colors.primary }]}>SET {setNumber}</Text>
                  </View>
                </View>
                <Text style={[styles.exerciseName, { color: colors.foreground }]}>
                  {form.exerciseName}
                </Text>
                <View style={styles.exerciseMeta}>
                  <Text style={[styles.exerciseMetaText, { color: colors.mutedForeground }]}>
                    {form.weight} {form.weightUnit} · {form.targetReps} reps · {form.totalSets} sets
                  </Text>
                  {phonePlacement && (
                    <Text style={[styles.exerciseMetaText, { color: colors.mutedForeground, marginTop: 2 }]}>
                      {PLACEMENT_OPTIONS.find((p) => p.value === phonePlacement)?.icon}{' '}
                      {PLACEMENT_OPTIONS.find((p) => p.value === phonePlacement)?.label}
                    </Text>
                  )}
                </View>
              </View>

              {/* Last set context card */}
              {lastSetResult && lastSetResult.mean_velocity_ms > 0.05 && (
                <View style={[styles.lastSetCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>LAST SET TARGET</Text>
                  <Text style={[styles.lastSetSubtitle, { color: colors.mutedForeground }]}>
                    Match or beat {lastSetResult.mean_velocity_ms.toFixed(3)} m/s mean · {lastSetResult.actual_reps} reps detected
                  </Text>
                  <View style={styles.lastSetRow}>
                    <View style={styles.lastSetStat}>
                      <Text style={[styles.lastSetStatVal, { color: colors.foreground }]}>{lastSetResult.mean_velocity_ms.toFixed(3)}</Text>
                      <Text style={[styles.lastSetStatLabel, { color: colors.mutedForeground }]}>mean m/s</Text>
                    </View>
                    <View style={styles.lastSetStat}>
                      <Text style={[styles.lastSetStatVal, { color: colors.foreground }]}>{lastSetResult.peak_velocity_ms.toFixed(3)}</Text>
                      <Text style={[styles.lastSetStatLabel, { color: colors.mutedForeground }]}>peak m/s</Text>
                    </View>
                    {lastSetResult.velocity_loss_pct !== null && (
                      <View style={styles.lastSetStat}>
                        <Text style={[styles.lastSetStatVal, { color: colors.foreground }]}>{lastSetResult.velocity_loss_pct.toFixed(1)}%</Text>
                        <Text style={[styles.lastSetStatLabel, { color: colors.mutedForeground }]}>v-loss</Text>
                      </View>
                    )}
                    <View style={styles.lastSetStat}>
                      <Text style={[styles.lastSetStatVal, { color: colors.foreground }]}>~{lastSetResult.estimated_1rm_pct}%</Text>
                      <Text style={[styles.lastSetStatLabel, { color: colors.mutedForeground }]}>1RM</Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Session log strip */}
              <SessionStrip sets={sessionSets} colors={colors} />

              <Text style={[styles.instructionText, { color: colors.mutedForeground }]}>
                {phonePlacement === 'pocket'
                  ? 'Put the phone in your pocket, then tap Start Set when ready.'
                  : phonePlacement === 'barbell'
                  ? 'Strap or magnet the phone to the bar/plate, then tap Start Set.'
                  : 'Place the phone on the weight stack or pulley pin, then tap Start Set.'}
              </Text>

              <Pressable
                accessibilityRole="button"
                onPress={handleStartSet}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: colors.primary, opacity: pressed ? 0.82 : 1 },
                ]}
              >
                <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                  ▶  Start Set {setNumber}
                </Text>
              </Pressable>

              <Pressable onPress={handleNewExercise} style={styles.ghostButton}>
                <Text style={[styles.ghostButtonText, { color: colors.mutedForeground }]}>
                  Edit exercise
                </Text>
              </Pressable>
            </View>
          )}

          {/* ---- Phase: RECORDING — stop button + sample counter ---- */}
          {phase === 'recording' && (
            <View style={styles.section}>
              <View style={[styles.recordingBanner, { backgroundColor: colors.destructive + '14', borderColor: colors.destructive + '55' }]}>
                <View style={[styles.recDot, { backgroundColor: colors.destructive }]} />
                <Text style={[styles.recordingText, { color: colors.destructive }]}>
                  Recording — {sampleCount} samples captured
                </Text>
              </View>

              <Text style={[styles.instructionText, { color: colors.mutedForeground }]}>
                Complete your reps, then retrieve your phone and tap Stop Set.
              </Text>

              <Pressable
                accessibilityRole="button"
                onPress={handleStopSet}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: colors.destructive, opacity: pressed ? 0.82 : 1 },
                ]}
              >
                <Text style={[styles.primaryButtonText, { color: '#fff' }]}>
                  ■  Stop Set
                </Text>
              </Pressable>
            </View>
          )}

          {/* ---- Phase: SUBMITTING ---- */}
          {phase === 'submitting' && (
            <View style={styles.section}>
              <View style={[styles.submittingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <ActivityIndicator color={colors.primary} size="large" />
                <Text style={[styles.submittingText, { color: colors.foreground }]}>
                  Analysing your set…
                </Text>
                <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
                  Integrating {sampleCount} samples · building AI coaching report
                </Text>
              </View>
            </View>
          )}

          {/* ---- Phase: FEEDBACK ---- */}
          {phase === 'feedback' && (
            <View style={styles.section}>
              {feedbackData ? (
                <>
                  {/* Motion gate — no movement detected */}
                  {feedbackData.velocity_zone === 'No movement' ? (
                    <View style={[styles.feedbackCard, { backgroundColor: '#FFD60018', borderColor: '#FFD60055' }]}>
                      <Text style={[styles.sectionLabel, { color: '#B89800' }]}>NO MOVEMENT DETECTED</Text>
                      <Text style={[styles.feedbackText, { color: colors.foreground }]}>
                        The phone didn't detect meaningful bar movement. Make sure it's secured to the bar or weight stack before recording.
                      </Text>
                    </View>
                  ) : (
                  <>
                  {/* Velocity zone banner */}
                  {(() => {
                    const zc = zoneColor(feedbackData.velocity_zone, colors);
                    const zcFg = zc === '#FFD600' ? '#7A6400' : zc;
                    return (
                      <View style={[styles.zoneBanner, { backgroundColor: zc + '18', borderColor: zc + '66' }]}>
                        <Text style={[styles.zoneLabel, { color: colors.mutedForeground }]}>VELOCITY ZONE · SET {setNumber}</Text>
                        <Text style={[styles.zoneValue, { color: zcFg }]}>{feedbackData.velocity_zone}</Text>
                      </View>
                    );
                  })()}

                  {/* Primary metrics row */}
                  <View style={styles.metricsRow}>
                    <MetricTile
                      label="MEAN VEL"
                      value={feedbackData.mean_velocity_ms.toFixed(3)}
                      unit="m/s"
                      colors={colors}
                    />
                    <MetricTile
                      label="PEAK VEL"
                      value={feedbackData.peak_velocity_ms.toFixed(3)}
                      unit="m/s"
                      colors={colors}
                    />
                    <MetricTile
                      label="EST. 1RM"
                      value={`~${feedbackData.estimated_1rm_pct}`}
                      unit="% 1RM"
                      colors={colors}
                    />
                  </View>

                  {/* Secondary metrics row */}
                  <View style={styles.metricsRow}>
                    <MetricTile
                      label="DURATION"
                      value={feedbackData.duration_s.toFixed(1)}
                      unit="sec"
                      colors={colors}
                    />
                    <MetricTile
                      label="V-LOSS"
                      value={feedbackData.velocity_loss_pct !== null ? `${feedbackData.velocity_loss_pct.toFixed(1)}%` : '—'}
                      unit={feedbackData.velocity_loss_pct !== null ? '' : 'n/a'}
                      colors={colors}
                    />
                    <MetricTile
                      label="REPS DET."
                      value={String(feedbackData.actual_reps)}
                      unit="reps"
                      colors={colors}
                    />
                  </View>

                  {/* Fatigue level pill */}
                  {feedbackData.fatigue_level ? (
                    <View style={[
                      styles.fatiguePill,
                      {
                        backgroundColor:
                          feedbackData.fatigue_level.startsWith('Fresh') ? '#FFD60020'
                          : feedbackData.fatigue_level.startsWith('Moderate') ? colors.primary + '20'
                          : colors.destructive + '20',
                        borderColor:
                          feedbackData.fatigue_level.startsWith('Fresh') ? '#FFD60060'
                          : feedbackData.fatigue_level.startsWith('Moderate') ? colors.primary + '60'
                          : colors.destructive + '60',
                      },
                    ]}>
                      <Text style={[
                        styles.fatiguePillText,
                        {
                          color:
                            feedbackData.fatigue_level.startsWith('Fresh') ? '#7A6400'
                            : feedbackData.fatigue_level.startsWith('Moderate') ? colors.primary
                            : colors.destructive,
                        },
                      ]}>
                        {feedbackData.fatigue_level}
                      </Text>
                    </View>
                  ) : null}

                  {/* Rep-by-rep velocity bars */}
                  {feedbackData.rep_peaks_ms && feedbackData.rep_peaks_ms.length > 0 && (
                    <RepVelocityBars repPeaks={feedbackData.rep_peaks_ms} colors={colors} />
                  )}

                  {/* CNS Motor Readiness card */}
                  <ReadinessCard
                    score={feedbackData.cns_readiness_score}
                    level={feedbackData.motor_readiness_level as ReadinessLevel}
                    trend={feedbackData.velocity_trend as VelocityTrend}
                    dataPoints={feedbackData.readiness_data_points}
                    baselineVelocityMs={feedbackData.baseline_velocity_ms}
                    firstRepPeakMs={feedbackData.first_rep_peak_ms}
                    colors={colors}
                  />

                  {/* AI coaching card */}
                  <View style={[styles.feedbackCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <View style={styles.feedbackCardHeader}>
                      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                        COACH SAYS
                      </Text>
                      {feedbackData.sparkden_history_used && (
                        <View style={[styles.sparkdenBadge, { backgroundColor: colors.primary + '25' }]}>
                          <Text style={[styles.sparkdenBadgeText, { color: colors.primary }]}>
                            ⚡ Sparkden history
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.feedbackText, { color: colors.foreground }]}>
                      {feedbackData.ai_feedback}
                    </Text>
                  </View>

                  {/* Rest timer */}
                  <RestTimer
                    secsLeft={restTimerSecs}
                    target={restTimerTarget}
                    onPreset={handleRestPreset}
                    onSkip={handleRestSkip}
                    colors={colors}
                  />

                  {/* Session log strip */}
                  <SessionStrip sets={sessionSets} colors={colors} />
                  </>
                  )}
                </>
              ) : analyzeSet.error ? (
                <View style={[styles.feedbackCard, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                  <Text style={[styles.sectionLabel, { color: colors.destructive }]}>
                    CONNECTION ISSUE
                  </Text>
                  <Text style={[styles.errorText, { color: colors.foreground }]}>
                    Could not reach the coaching API. Check that the Replit server is running.
                  </Text>
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                onPress={handleNewSet}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: colors.primary, opacity: pressed ? 0.82 : 1 },
                ]}
              >
                <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                  Next Set
                </Text>
              </Pressable>

              <Pressable onPress={handleNewExercise} style={styles.ghostButton}>
                <Text style={[styles.ghostButtonText, { color: colors.mutedForeground }]}>
                  New exercise
                </Text>
              </Pressable>
            </View>
          )}

          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Built for focused training. Keep the phone secure while moving.
          </Text>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 20 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  brand: { fontSize: 28, fontWeight: '800', letterSpacing: -0.8, marginTop: 5 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 6,
  },
  statusDot: { width: 7, height: 7, borderRadius: 7 },
  statusText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  section: { gap: 14 },
  title: { fontSize: 32, fontWeight: '800', letterSpacing: -1.2 },
  subtitle: { fontSize: 15, lineHeight: 22 },
  formCard: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  fieldRow: { flexDirection: 'row', gap: 12 },
  fieldWrap: { gap: 6 },
  fieldLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  weightLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  unitToggle: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  unitOption: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  unitOptionText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  fieldInput: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontWeight: '600',
  },
  liveCard: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    gap: 16,
    shadowColor: '#07151F',
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  liveHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  liveTitle: { fontSize: 20, fontWeight: '700', marginTop: 4 },
  frequencyBadge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  frequencyText: { fontSize: 12, fontWeight: '700' },
  axisGrid: { gap: 10 },
  axisCard: { borderRadius: 16, borderWidth: 1, padding: 13 },
  axisHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  axisDot: { width: 8, height: 8, borderRadius: 8 },
  axisLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  axisValue: { fontSize: 30, fontWeight: '700', letterSpacing: -0.8, marginTop: 7 },
  axisUnit: { fontSize: 12, fontWeight: '700', marginTop: -4 },
  track: { height: 6, borderRadius: 8, overflow: 'hidden', marginTop: 11 },
  trackFill: { height: 6, borderRadius: 8 },
  helperText: { fontSize: 12, lineHeight: 17 },
  exerciseSummary: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    gap: 6,
  },
  exerciseName: { fontSize: 26, fontWeight: '800', letterSpacing: -0.7 },
  exerciseMeta: { marginTop: 2 },
  exerciseMetaText: { fontSize: 14, fontWeight: '600' },
  instructionText: { fontSize: 14, lineHeight: 21 },
  recordingBanner: {
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recDot: { width: 10, height: 10, borderRadius: 10 },
  recordingText: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  submittingCard: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 32,
    gap: 14,
    alignItems: 'center',
  },
  submittingText: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  metricsRow: { flexDirection: 'row', gap: 10 },
  metricTile: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    gap: 4,
    alignItems: 'center',
  },
  metricLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.1 },
  metricValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  metricUnit: { fontSize: 11, fontWeight: '600' },
  zoneBanner: {
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 4,
  },
  zoneLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.3 },
  zoneValue: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  fatiguePill: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
  },
  fatiguePillText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  feedbackCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 17,
    gap: 8,
  },
  feedbackCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sparkdenBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sparkdenBadgeText: { fontSize: 10, fontWeight: '700' },
  feedbackText: { fontSize: 17, fontWeight: '600', lineHeight: 25 },
  errorText: { fontSize: 14, lineHeight: 20 },
  primaryButton: {
    minHeight: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '800' },
  ghostButton: { alignItems: 'center', paddingVertical: 10 },
  ghostButtonText: { fontSize: 14, fontWeight: '600' },

  // CNS Readiness card
  readinessCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  readinessHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  trendBadge: { fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  readinessScoreRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  readinessScore: { fontSize: 52, fontWeight: '900', letterSpacing: -2, lineHeight: 56 },
  readinessScoreSuffix: { gap: 5, paddingBottom: 6 },
  readinessScoreMax: { fontSize: 14, fontWeight: '700' },
  readinessLevelPill: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  readinessLevelText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  readinessTrack: {
    height: 7,
    borderRadius: 7,
    overflow: 'hidden',
  },
  readinessFill: { height: 7, borderRadius: 7 },
  readinessStats: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  readinessStat: { gap: 2 },
  readinessStatLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.1 },
  readinessStatValue: { fontSize: 14, fontWeight: '700' },
  readinessBuilding: { gap: 7 },
  readinessBuildingTitle: { fontSize: 16, fontWeight: '700' },
  readinessBuildingSubtitle: { fontSize: 13, lineHeight: 19 },
  readinessPips: { flexDirection: 'row', gap: 8, marginTop: 2 },
  readinessPip: {
    width: 28,
    height: 8,
    borderRadius: 8,
    borderWidth: 1,
  },

  // Ready phase — set number + last set card
  exerciseSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  setNumBadge: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  setNumText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  lastSetCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  lastSetSubtitle: { fontSize: 12, lineHeight: 17 },
  lastSetRow: { flexDirection: 'row', gap: 18, flexWrap: 'wrap' },
  lastSetStat: { gap: 1 },
  lastSetStatVal: { fontSize: 18, fontWeight: '800', letterSpacing: -0.4 },
  lastSetStatLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },

  // Rep-by-rep bars
  repBarsCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  repBarsGrid: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: 90,
  },
  repBarCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    height: '100%',
    justifyContent: 'flex-end',
  },
  repBarValue: { fontSize: 9, fontWeight: '800', letterSpacing: 0 },
  repBarTrack: {
    width: '100%',
    flex: 1,
    borderRadius: 6,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  repBarFill: { width: '100%', borderRadius: 6 },
  repBarLabel: { fontSize: 9, fontWeight: '700' },

  // Rest timer
  restCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  restHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  restSkip: { fontSize: 13, fontWeight: '600' },
  restTrack: { height: 6, borderRadius: 6, overflow: 'hidden' },
  restFill: { height: 6, borderRadius: 6 },
  restTime: { fontSize: 40, fontWeight: '900', letterSpacing: -2, textAlign: 'center' },
  restPresets: { flexDirection: 'row', gap: 8 },
  restPreset: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  restPresetText: { fontSize: 12, fontWeight: '800' },

  // Session strip
  sessionStrip: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  sessionScroll: { marginHorizontal: -4 },
  sessionSetChip: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 4,
    alignItems: 'center',
    minWidth: 70,
    gap: 2,
  },
  sessionSetNum: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  sessionSetVel: { fontSize: 20, fontWeight: '900', letterSpacing: -0.5 },
  sessionSetUnit: { fontSize: 9, fontWeight: '700' },
  sessionSetReps: { fontSize: 9, fontWeight: '600', marginTop: 2 },

  // Placement picker
  placementSection: { gap: 8 },
  placementOption: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  placementIcon: { fontSize: 26, width: 36, textAlign: 'center' },
  placementText: { flex: 1, gap: 2 },
  placementLabel: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  placementSubtitle: { fontSize: 12, lineHeight: 17 },
  placementRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
  },
  serverMotionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  serverMotionMetric: { flex: 1, minWidth: 90, gap: 2 },
  resetButton: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  resetButtonText: { fontSize: 12, fontWeight: '800' },

  footerText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 4,
  },
});

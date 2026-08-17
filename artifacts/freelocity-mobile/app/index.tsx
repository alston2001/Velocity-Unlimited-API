import { useAnalyzeSet } from '@workspace/api-client-react';
import type { AccelerationSample } from '@workspace/api-client-react';
import { Accelerometer } from 'expo-sensors';
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

type FormValues = {
  exerciseName: string;
  weightKg: string;
  targetReps: string;
  totalSets: string;
};

const RECORD_HZ = 50; // 50 Hz during recording
const IDLE_HZ = 10;   // 10 Hz for live preview only

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
// Main screen
// ---------------------------------------------------------------------------

export default function MotionTrackerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Sensor
  const [sensorAvailable, setSensorAvailable] = useState<boolean | null>(null);
  const [live, setLive] = useState<SensorReading>({ x: 0, y: 0, z: 0 });
  const sampleBuffer = useRef<AccelerationSample[]>([]);

  // Workflow state
  const [phase, setPhase] = useState<Phase>('setup');
  const [form, setForm] = useState<FormValues>({
    exerciseName: '',
    weightKg: '',
    targetReps: '',
    totalSets: '',
  });
  const [sampleCount, setSampleCount] = useState(0);

  const analyzeSet = useAnalyzeSet();

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
  }, [phase, sensorAvailable]);

  // ---------------------------------------------------------------------------
  // Form helpers
  // ---------------------------------------------------------------------------

  function setField(key: keyof FormValues) {
    return (v: string) => setForm((f) => ({ ...f, [key]: v }));
  }

  const formValid =
    form.exerciseName.trim().length > 0 &&
    parseFloat(form.weightKg) > 0 &&
    parseInt(form.targetReps) > 0 &&
    parseInt(form.totalSets) > 0;

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
    setPhase('recording');
  }

  function handleStopSet() {
    const samples = [...sampleBuffer.current];
    setPhase('submitting');

    analyzeSet.mutate(
      {
        data: {
          exercise_name: form.exerciseName.trim(),
          weight_kg: parseFloat(form.weightKg),
          target_reps: parseInt(form.targetReps),
          total_sets: parseInt(form.totalSets),
          samples,
        },
      },
      {
        onSuccess: () => setPhase('feedback'),
        onError: () => setPhase('feedback'),
      },
    );
  }

  function handleNewSet() {
    sampleBuffer.current = [];
    setSampleCount(0);
    analyzeSet.reset();
    setPhase('ready'); // back to ready with same exercise config
  }

  function handleNewExercise() {
    sampleBuffer.current = [];
    setSampleCount(0);
    analyzeSet.reset();
    setPhase('setup');
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
                <FormField
                  label="WEIGHT (KG)"
                  value={form.weightKg}
                  onChangeText={setField('weightKg')}
                  placeholder="e.g. 100"
                  keyboardType="decimal-pad"
                  colors={colors}
                />
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
                <AxisCard axis="X" value={live.x} color={colors.primary} colors={colors} highlight={isRecording} />
                <AxisCard axis="Y" value={live.y} color={colors.accent} colors={colors} highlight={isRecording} />
                <AxisCard axis="Z" value={live.z} color="#6E8BFF" colors={colors} highlight={isRecording} />
              </View>

              <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
                Values are in G. Place the phone on the weight stack before starting.
              </Text>
            </View>
          )}

          {/* ---- Phase: READY — exercise summary + Start Set ---- */}
          {phase === 'ready' && (
            <View style={styles.section}>
              <View style={[styles.exerciseSummary, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>EXERCISE</Text>
                <Text style={[styles.exerciseName, { color: colors.foreground }]}>
                  {form.exerciseName}
                </Text>
                <View style={styles.exerciseMeta}>
                  <Text style={[styles.exerciseMetaText, { color: colors.mutedForeground }]}>
                    {form.weightKg} kg · {form.targetReps} reps · {form.totalSets} sets
                  </Text>
                </View>
              </View>

              <Text style={[styles.instructionText, { color: colors.mutedForeground }]}>
                Place your phone securely on the bar or weight stack, then tap Start Set.
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
                  ▶  Start Set
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
                  Integrating velocity…
                </Text>
                <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
                  Sending {sampleCount} samples to the coaching API
                </Text>
              </View>
            </View>
          )}

          {/* ---- Phase: FEEDBACK ---- */}
          {phase === 'feedback' && (
            <View style={styles.section}>
              {feedbackData ? (
                <>
                  <View style={styles.metricsRow}>
                    <MetricTile
                      label="MEAN VEL"
                      value={feedbackData.mean_velocity_ms.toFixed(2)}
                      unit="m/s"
                      colors={colors}
                    />
                    <MetricTile
                      label="PEAK VEL"
                      value={feedbackData.peak_velocity_ms.toFixed(2)}
                      unit="m/s"
                      colors={colors}
                    />
                    <MetricTile
                      label="DURATION"
                      value={feedbackData.duration_s.toFixed(1)}
                      unit="sec"
                      colors={colors}
                    />
                  </View>

                  <View style={[styles.feedbackCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                      COACH SAYS
                    </Text>
                    <Text style={[styles.feedbackText, { color: colors.foreground }]}>
                      {feedbackData.ai_feedback}
                    </Text>
                  </View>
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
  feedbackCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 17,
    gap: 8,
  },
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
  footerText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 4,
  },
});

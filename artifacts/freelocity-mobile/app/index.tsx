import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer } from 'expo-sensors';
import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';
import type { SetSummary, TrackerMode } from '@/src/lib/vbtTracker';

const NEON_YELLOW = '#FFFF00';
const IMU_DT = 1 / 60;

type Colors = ReturnType<typeof useColors>;

function format(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.00';
}

function modeForExercise(exercise: string): TrackerMode {
  return /pulley|cable|lat|fly|pressdown|pushdown/i.test(exercise)
    ? 'PULLEY_FRONT'
    : 'FREE_WEIGHT_SIDE';
}

function phaseLabel(phase: string) {
  return phase === 'ACTIVE' ? 'TRACKING' : phase === 'COOLDOWN' ? 'SET READY' : 'IDLE';
}

function SetSummaryModal({
  summary,
  colors,
  onNextSet,
}: {
  summary: SetSummary | null;
  colors: Colors;
  onNextSet: () => void;
}) {
  if (!summary) return null;
  const maxPeak = Math.max(...summary.peakVelocities, 0.01);
  return (
    <Modal visible animationType="slide" onRequestClose={onNextSet}>
      <View style={[styles.modalRoot, { backgroundColor: colors.background }]}>
        <Text style={[styles.modalEyebrow, { color: colors.primary }]}>SET COMPLETE</Text>
        <Text style={[styles.modalTitle, { color: colors.foreground }]}>Velocity report</Text>
        <View style={styles.summaryGrid}>
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>TOTAL REPS</Text>
            <Text style={[styles.summaryValue, { color: colors.foreground }]}>{summary.reps.length}</Text>
          </View>
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>MEAN REP TIME</Text>
            <Text style={[styles.summaryValue, { color: colors.primary }]}>{format(summary.meanRepTime, 2)}</Text>
            <Text style={[styles.summaryUnit, { color: colors.mutedForeground }]}>sec</Text>
          </View>
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>TOP SPEED</Text>
            <Text style={[styles.summaryValue, { color: colors.accent }]}>{format(summary.topSpeed)}</Text>
            <Text style={[styles.summaryUnit, { color: colors.mutedForeground }]}>m/s</Text>
          </View>
        </View>
        <View style={[styles.chartCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.chartTitle, { color: colors.foreground }]}>PEAK VELOCITY / REP</Text>
          <View style={styles.chart}>
            {summary.peakVelocities.map((peak, index) => (
              <View key={`${index}-${peak}`} style={styles.barColumn}>
                <Text style={[styles.barValue, { color: colors.mutedForeground }]}>{format(peak)}</Text>
                <View
                  style={[
                    styles.velocityBar,
                    {
                      height: Math.max(8, (peak / maxPeak) * 130),
                      backgroundColor: colors.primary,
                    },
                  ]}
                />
                <Text style={[styles.barLabel, { color: colors.mutedForeground }]}>{index + 1}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[styles.consistencyCard, { backgroundColor: colors.secondary }]}>
          <View>
            <Text style={[styles.summaryLabel, { color: colors.secondaryForeground }]}>CONSISTENCY SCORE</Text>
            <Text style={[styles.consistencyValue, { color: colors.secondaryForeground }]}>
              {format(summary.consistencyScore, 0)}
            </Text>
          </View>
          <Text style={[styles.consistencyFormula, { color: colors.secondaryForeground }]}>
            max(0, min(100, 100 × (1 − σ / μ)))
          </Text>
        </View>
        <Pressable
          onPress={onNextSet}
          style={({ pressed }) => [
            styles.primaryButton,
            { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Text style={styles.primaryButtonText}>START NEXT SET</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

export default function MotionTrackerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [exercise, setExercise] = useState('Squat');
  const [cameraFacing, setCameraFacing] = useState<'front' | 'back'>('back');
  const [assistantMode, setAssistantMode] = useState(false);
  const [customReference, setCustomReference] = useState('0.50');
  const [summary, setSummary] = useState<SetSummary | null>(null);
  const mode = useMemo(() => modeForExercise(exercise), [exercise]);
  const tracker = useVbtTracker(mode);

  useKeepAwake();

  useEffect(() => {
    if (Platform.OS === 'web' || !permission?.granted) return;
    Accelerometer.setUpdateInterval(1000 / 60);
    const subscription = Accelerometer.addListener((data) => {
      const next = tracker.updateImu(data.y * 9.81, IMU_DT);
      if (next.completedSet) setSummary(next.completedSet);
    });
    return () => subscription.remove();
  }, [permission?.granted, tracker.updateImu]);

  useEffect(() => {
    if (tracker.completedSet && !summary) setSummary(tracker.completedSet);
  }, [summary, tracker.completedSet]);

  const manualRep = useCallback(() => {
    const next = tracker.manualIncrementRep();
    if (next.completedSet) setSummary(next.completedSet);
  }, [tracker.manualIncrementRep]);

  const calibrate = useCallback(() => {
    if (mode === 'FREE_WEIGHT_SIDE') {
      tracker.calibratePlate(300);
    } else {
      const referenceMeters = Number.parseFloat(customReference);
      if (Number.isFinite(referenceMeters)) tracker.setCustomReference(referenceMeters, 300);
    }
  }, [customReference, mode, tracker.calibratePlate, tracker.setCustomReference]);

  const nextSet = useCallback(() => {
    tracker.resetTracker();
    setSummary(null);
  }, [tracker.resetTracker]);

  if (!permission) {
    return (
      <View style={styles.permissionRoot}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionRoot}>
        <Text style={[styles.permissionEyebrow, { color: colors.primary }]}>FREELOCITY / MOTION TRACKER</Text>
        <Text style={[styles.permissionTitle, { color: colors.foreground }]}>Camera access required</Text>
        <Text style={[styles.permissionBody, { color: colors.mutedForeground }]}>
          Motion tracking needs a live camera feed. Camera frames stay in volatile memory.
        </Text>
        <Pressable onPress={requestPermission} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
          <Text style={styles.primaryButtonText}>ALLOW CAMERA</Text>
        </Pressable>
      </View>
    );
  }

  const centroidStyle = tracker.centroid
    ? {
        left: `${Math.min(94, Math.max(2, (tracker.centroid.x / 1080) * 100))}%`,
        top: `${Math.min(82, Math.max(10, (tracker.centroid.y / 1920) * 100))}%`,
      }
    : { left: '50%', top: '45%' };
  const gaugePosition = `${Math.min(92, Math.max(8, 50 - tracker.displacement * 90))}%`;

  return (
    <View style={styles.root}>
      <CameraView
        facing={mode === 'FREE_WEIGHT_SIDE' ? 'back' : cameraFacing}
        style={StyleSheet.absoluteFillObject}
      />
      <View style={styles.cameraShade} pointerEvents="none" />
      {assistantMode && (
        <Pressable
          accessibilityLabel="Manual assistant tap surface"
          onPress={manualRep}
          style={StyleSheet.absoluteFillObject}
        />
      )}

      <View style={[styles.topHud, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topBar}>
          <View style={styles.statBlock}>
            <Text style={styles.statLabel}>REPS</Text>
            <Text style={styles.statValue}>{tracker.reps.length}</Text>
          </View>
          <View style={styles.statBlock}>
            <Text style={styles.statLabel}>VELOCITY</Text>
            <Text style={styles.statValue}>{format(tracker.currentVelocity)}</Text>
            <Text style={styles.statUnit}>m/s</Text>
          </View>
          <View style={styles.statBlock}>
            <Text style={styles.statLabel}>DISPLACEMENT</Text>
            <Text style={styles.statValue}>{format(tracker.displacement)}</Text>
            <Text style={styles.statUnit}>m</Text>
          </View>
          <View style={[styles.phasePill, { borderColor: tracker.phase === 'ACTIVE' ? '#00FF88' : colors.border }]}>
            <Text style={styles.phaseText}>{phaseLabel(tracker.phase)}</Text>
          </View>
        </View>
      </View>

      {mode === 'FREE_WEIGHT_SIDE' && (
        <>
          <View style={[styles.targetBox, centroidStyle]} />
          {tracker.trajectory.map((point, index) => (
            <View
              key={`${point.x}-${point.y}-${index}`}
              style={[
                styles.trailDot,
                {
                  left: `${Math.min(98, Math.max(0, (point.x / 1080) * 100))}%`,
                  top: `${Math.min(92, Math.max(5, (point.y / 1920) * 100))}%`,
                  opacity: (index + 1) / tracker.trajectory.length,
                },
              ]}
            />
          ))}
        </>
      )}
      {mode === 'PULLEY_FRONT' && (
        <View style={styles.gaugeRail}>
          <View style={styles.gaugeLine} />
          <View style={[styles.gaugeMarker, { top: gaugePosition }]} />
          <Text style={styles.gaugeText}>VERTICAL DISPLACEMENT</Text>
        </View>
      )}

      <View style={[styles.bottomHud, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.exerciseCard}>
          <View style={styles.exerciseHeader}>
            <Text style={styles.sectionLabel}>EXERCISE</Text>
            <Text style={styles.modeLabel}>{mode === 'FREE_WEIGHT_SIDE' ? 'MODE A · SIDE' : 'MODE B · FRONT'}</Text>
          </View>
          <TextInput
            value={exercise}
            onChangeText={setExercise}
            placeholder="e.g. Squat, bench, cable row"
            placeholderTextColor="rgba(255,255,255,0.45)"
            style={styles.exerciseInput}
          />
          <Text style={styles.modeHint}>
            {mode === 'FREE_WEIGHT_SIDE'
              ? 'Free weight side profile · rear camera · 60–120 FPS'
              : 'Pulley / cable front profile · optical-flow displacement'}
          </Text>
          <View style={styles.controlRow}>
            <View style={styles.controlGroup}>
              <Text style={styles.sectionLabel}>CALIBRATION</Text>
              {mode === 'FREE_WEIGHT_SIDE' ? (
                <Text style={styles.calibrationText}>450 mm plate diameter only</Text>
              ) : (
                <TextInput
                  value={customReference}
                  onChangeText={setCustomReference}
                  keyboardType="decimal-pad"
                  style={styles.referenceInput}
                  placeholder="Stroke / pose m"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                />
              )}
            </View>
            <Pressable onPress={calibrate} style={styles.outlineButton}>
              <Text style={styles.outlineButtonText}>SET REFERENCE</Text>
            </Pressable>
          </View>
          <View style={styles.controlRow}>
            <View style={styles.assistantRow}>
              <Text style={styles.sectionLabel}>MANUAL ASSISTANT</Text>
              <Switch
                value={assistantMode}
                onValueChange={setAssistantMode}
                trackColor={{ false: '#27424E', true: '#0FA6A0' }}
                thumbColor="#FFFFFF"
              />
            </View>
            {mode === 'PULLEY_FRONT' && (
              <Pressable onPress={() => setCameraFacing((current) => (current === 'front' ? 'back' : 'front'))}>
                <Text style={styles.cameraToggle}>{cameraFacing === 'front' ? 'FRONT CAM' : 'REAR CAM'}</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.helperText}>
            {assistantMode
              ? 'Tap anywhere on the camera to manually increment reps. Kinetic logging continues.'
              : 'Move to trigger CV tracking. The set finalizes after 2.5 seconds of stillness.'}
          </Text>
          <Pressable onPress={nextSet} style={[styles.resetButton, { borderColor: colors.border }]}>
            <Text style={styles.resetButtonText}>RESET SET</Text>
          </Pressable>
        </View>
      </View>

      <SetSummaryModal summary={summary} colors={colors} onNextSet={nextSet} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#07151F', flex: 1 },
  cameraShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.42)' },
  topHud: { left: 0, paddingHorizontal: 14, position: 'absolute', right: 0, top: 0 },
  topBar: {
    alignItems: 'center',
    backgroundColor: 'rgba(7,21,31,0.86)',
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statBlock: { minWidth: 54 },
  statLabel: { color: 'rgba(255,255,255,0.58)', fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  statValue: { color: '#FFFFFF', fontSize: 20, fontWeight: '800', marginTop: 3 },
  statUnit: { color: '#00FF88', fontSize: 9, fontWeight: '700' },
  phasePill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 7 },
  phaseText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  targetBox: {
    borderColor: NEON_YELLOW,
    borderRadius: 7,
    borderWidth: 3,
    height: 48,
    marginLeft: -24,
    marginTop: -24,
    position: 'absolute',
    width: 48,
  },
  trailDot: { backgroundColor: NEON_YELLOW, borderRadius: 3, height: 6, position: 'absolute', width: 6 },
  gaugeRail: {
    alignItems: 'center',
    bottom: '31%',
    position: 'absolute',
    right: 20,
    top: '25%',
    width: 48,
  },
  gaugeLine: { backgroundColor: '#00FF88', height: '100%', width: 3 },
  gaugeMarker: { backgroundColor: '#00FF88', borderRadius: 5, height: 10, marginTop: -5, position: 'absolute', width: 28 },
  gaugeText: { color: '#00FF88', fontSize: 8, fontWeight: '800', letterSpacing: 1, position: 'absolute', right: 13, top: '40%', transform: [{ rotate: '-90deg' }], width: 130 },
  bottomHud: { bottom: 0, left: 0, paddingHorizontal: 14, position: 'absolute', right: 0 },
  exerciseCard: { backgroundColor: 'rgba(7,21,31,0.9)', borderColor: 'rgba(255,255,255,0.15)', borderRadius: 20, borderWidth: 1, gap: 9, padding: 14 },
  exerciseHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  sectionLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  modeLabel: { color: '#00FF88', fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  exerciseInput: { borderBottomColor: 'rgba(255,255,255,0.28)', borderBottomWidth: 1, color: '#FFFFFF', fontSize: 21, fontWeight: '800', paddingBottom: 7, paddingTop: 2 },
  modeHint: { color: 'rgba(255,255,255,0.6)', fontSize: 10 },
  controlRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  controlGroup: { flex: 1, gap: 4 },
  calibrationText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  referenceInput: { borderBottomColor: 'rgba(255,255,255,0.28)', borderBottomWidth: 1, color: '#FFFFFF', fontSize: 13, paddingVertical: 2, width: 110 },
  outlineButton: { borderColor: '#00FF88', borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  outlineButtonText: { color: '#00FF88', fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },
  assistantRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  cameraToggle: { color: '#FF8069', fontSize: 10, fontWeight: '900' },
  helperText: { color: 'rgba(255,255,255,0.5)', fontSize: 10, lineHeight: 15 },
  resetButton: { alignItems: 'center', borderRadius: 10, borderWidth: 1, minHeight: 32, justifyContent: 'center' },
  resetButtonText: { color: 'rgba(255,255,255,0.72)', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  permissionRoot: { alignItems: 'center', backgroundColor: '#07151F', flex: 1, justifyContent: 'center', padding: 28 },
  permissionEyebrow: { fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  permissionTitle: { fontSize: 29, fontWeight: '900', marginTop: 12, textAlign: 'center' },
  permissionBody: { fontSize: 14, lineHeight: 21, marginTop: 12, textAlign: 'center' },
  primaryButton: { alignItems: 'center', borderRadius: 15, justifyContent: 'center', marginTop: 22, minHeight: 54, paddingHorizontal: 20 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', letterSpacing: 0.8 },
  modalRoot: { flex: 1, gap: 15, padding: 20, paddingTop: 56 },
  modalEyebrow: { fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  modalTitle: { fontSize: 30, fontWeight: '900', letterSpacing: -1 },
  summaryGrid: { flexDirection: 'row', gap: 8 },
  summaryCard: { borderRadius: 15, borderWidth: 1, flex: 1, minHeight: 108, padding: 11 },
  summaryLabel: { fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  summaryValue: { fontSize: 23, fontWeight: '900', marginTop: 13 },
  summaryUnit: { fontSize: 10, marginTop: 1 },
  chartCard: { borderRadius: 17, borderWidth: 1, padding: 14 },
  chartTitle: { fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  chart: { alignItems: 'flex-end', flexDirection: 'row', gap: 10, height: 180, marginTop: 12 },
  barColumn: { alignItems: 'center', flex: 1, gap: 4, justifyContent: 'flex-end' },
  barValue: { fontSize: 9 },
  velocityBar: { borderRadius: 5, minHeight: 8, width: '72%' },
  barLabel: { fontSize: 9, fontWeight: '800' },
  consistencyCard: { alignItems: 'center', borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', padding: 15 },
  consistencyValue: { fontSize: 32, fontWeight: '900', marginTop: 4 },
  consistencyFormula: { fontSize: 11, fontWeight: '700' },
});
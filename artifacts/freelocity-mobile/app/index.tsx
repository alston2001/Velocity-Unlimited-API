import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer } from 'expo-sensors';
import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';

const NEON = '#00FF88';
const IMU_DT = 0.0166;
const MOUNTED_HZ = 60;
const REP_START_VELOCITY = 0.15;
const REP_END_VELOCITY = 0.05;
const REP_END_GRACE_SEC = 0.2;

type TrackingMode = 'mounted' | 'tripod';
type EquipmentType = 'cable' | 'barbell';

export type RepData = {
  repNumber: number;
  meanVelocity: number;
  peakVelocity: number;
  peakAccel: number;
  durationSec: number;
};

function formatNumber(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.00';
}

function segmentedButton(
  active: boolean,
  colors: ReturnType<typeof useColors>,
) {
  return {
    backgroundColor: active ? colors.primary : 'rgba(255,255,255,0.08)',
    borderColor: active ? colors.primary : 'rgba(255,255,255,0.2)',
  };
}

function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricUnit}>{unit}</Text>
    </View>
  );
}

function RepTable({ reps }: { reps: RepData[] }) {
  return (
    <View style={styles.table}>
      <View style={styles.tableRow}>
        <Text style={[styles.tableHeader, styles.repColumn]}>REP #</Text>
        <Text style={[styles.tableHeader, styles.valueColumn]}>MEAN VEL</Text>
        <Text style={[styles.tableHeader, styles.valueColumn]}>PEAK VEL</Text>
        <Text style={[styles.tableHeader, styles.valueColumn]}>PEAK ACCEL</Text>
      </View>
      {reps.map((rep) => (
        <View key={rep.repNumber} style={styles.tableRow}>
          <Text style={[styles.tableCell, styles.repColumn]}>{rep.repNumber}</Text>
          <Text style={[styles.tableCell, styles.valueColumn]}>
            {formatNumber(rep.meanVelocity)} m/s
          </Text>
          <Text style={[styles.tableCell, styles.valueColumn]}>
            {formatNumber(rep.peakVelocity)} m/s
          </Text>
          <Text style={[styles.tableCell, styles.valueColumn]}>
            {formatNumber(rep.peakAccel)} m/s²
          </Text>
        </View>
      ))}
    </View>
  );
}

function FeedbackModal({
  visible,
  reps,
  onNextSet,
  colors,
}: {
  visible: boolean;
  reps: RepData[];
  onNextSet: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const bestVelocity = reps.length
    ? Math.max(...reps.map((rep) => rep.peakVelocity))
    : 0;
  const firstVelocity = reps[0]?.meanVelocity ?? 0;
  const lastVelocity = reps[reps.length - 1]?.meanVelocity ?? firstVelocity;
  const velocityLoss =
    firstVelocity > 0
      ? Math.max(0, ((firstVelocity - lastVelocity) / firstVelocity) * 100)
      : 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onNextSet}>
      <View style={[styles.feedbackScreen, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={styles.feedbackContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.feedbackEyebrow, { color: colors.primary }]}>
            SET COMPLETE
          </Text>
          <Text style={[styles.feedbackTitle, { color: colors.foreground }]}>
            Your velocity report
          </Text>

          <View style={styles.summaryGrid}>
            <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>TOTAL REPS</Text>
              <Text style={[styles.summaryValue, { color: colors.foreground }]}>{reps.length}</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>BEST REP</Text>
              <Text style={[styles.summaryValue, { color: colors.primary }]}>
                {formatNumber(bestVelocity)}
              </Text>
              <Text style={[styles.summaryUnit, { color: colors.mutedForeground }]}>m/s</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>VELOCITY LOSS</Text>
              <Text style={[styles.summaryValue, { color: velocityLoss > 20 ? colors.destructive : colors.accent }]}>
                {formatNumber(velocityLoss, 1)}%
              </Text>
            </View>
          </View>

          <View style={[styles.breakdownCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.breakdownTitle, { color: colors.foreground }]}>
              REP-BY-REP BREAKDOWN
            </Text>
            {reps.length ? (
              <RepTable reps={reps} />
            ) : (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No complete reps detected. Try mounting the phone securely and
                keep the movement path vertical.
              </Text>
            )}
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={onNextSet}
            style={({ pressed }) => [
              styles.nextSetButton,
              { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={styles.nextSetButtonText}>START NEXT SET</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

export default function MotionTrackerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const vbtTracker = useVbtTracker();

  const [trackingMode, setTrackingMode] = useState<TrackingMode>('mounted');
  const [equipment, setEquipment] = useState<EquipmentType>('cable');
  const [isSetActive, setIsSetActive] = useState(false);
  const [sensorAvailable, setSensorAvailable] = useState<boolean | null>(null);
  const [liveAccel, setLiveAccel] = useState(0);
  const [reps, setReps] = useState<RepData[]>([]);
  const [showFeedback, setShowFeedback] = useState(false);

  const repActive = useRef(false);
  const repVelocities = useRef<number[]>([]);
  const repAccelerations = useRef<number[]>([]);
  const repStartedAt = useRef(0);
  const belowThresholdSec = useRef(0);

  useKeepAwake();

  const clearActiveRep = useCallback(() => {
    repActive.current = false;
    repVelocities.current = [];
    repAccelerations.current = [];
    repStartedAt.current = 0;
    belowThresholdSec.current = 0;
  }, []);

  const finishActiveRep = useCallback(() => {
    const velocities = repVelocities.current;
    const accelerations = repAccelerations.current;
    if (!repActive.current || velocities.length === 0) {
      clearActiveRep();
      return;
    }

    const meanVelocity =
      velocities.reduce((sum, velocity) => sum + velocity, 0) / velocities.length;
    const peakVelocity = Math.max(...velocities);
    const peakAccel = accelerations.length
      ? Math.max(...accelerations.map((accel) => Math.abs(accel)))
      : 0;
    const durationSec = Math.max(
      IMU_DT,
      (Date.now() - repStartedAt.current) / 1000,
    );

    setReps((current) => [
      ...current,
      {
        repNumber: current.length + 1,
        meanVelocity,
        peakVelocity,
        peakAccel,
        durationSec,
      },
    ]);
    clearActiveRep();
  }, [clearActiveRep]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      setSensorAvailable(false);
      return;
    }

    let active = true;
    Accelerometer.isAvailableAsync().then((available) => {
      if (active) setSensorAvailable(available);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !isSetActive ||
      trackingMode !== 'mounted' ||
      Platform.OS === 'web' ||
      sensorAvailable !== true
    ) {
      return;
    }

    Accelerometer.setUpdateInterval(1000 / MOUNTED_HZ);
    const subscription = Accelerometer.addListener((data) => {
      const accelY = data.y * 9.81;
      const trackerState = vbtTracker.update(0, accelY, IMU_DT);
      const upwardVelocity = Math.max(0, trackerState.velocity);
      setLiveAccel(accelY);

      if (!repActive.current) {
        if (upwardVelocity > REP_START_VELOCITY) {
          repActive.current = true;
          repStartedAt.current = Date.now();
          repVelocities.current = [upwardVelocity];
          repAccelerations.current = [accelY];
          belowThresholdSec.current = 0;
        }
        return;
      }

      repVelocities.current.push(upwardVelocity);
      repAccelerations.current.push(accelY);

      if (trackerState.velocity < REP_END_VELOCITY) {
        belowThresholdSec.current += IMU_DT;
        if (belowThresholdSec.current > REP_END_GRACE_SEC) {
          finishActiveRep();
        }
      } else {
        belowThresholdSec.current = 0;
      }
    });

    return () => subscription.remove();
  }, [
    finishActiveRep,
    isSetActive,
    sensorAvailable,
    trackingMode,
    vbtTracker.update,
  ]);

  const startSet = useCallback(() => {
    vbtTracker.resetTracker();
    clearActiveRep();
    setReps([]);
    setShowFeedback(false);
    setIsSetActive(true);
  }, [clearActiveRep, vbtTracker.resetTracker]);

  const finishSet = useCallback(() => {
    finishActiveRep();
    setIsSetActive(false);
    setShowFeedback(true);
  }, [finishActiveRep]);

  const nextSet = useCallback(() => {
    clearActiveRep();
    vbtTracker.resetTracker();
    setReps([]);
    setShowFeedback(false);
    setIsSetActive(false);
  }, [clearActiveRep, vbtTracker.resetTracker]);

  if (!permission) {
    return (
      <View style={styles.permissionScreen}>
        <ActivityIndicator color={NEON} size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <Text style={styles.permissionEyebrow}>FREELOCITY / MOTION LAB</Text>
        <Text style={styles.permissionTitle}>Camera access required</Text>
        <Text style={styles.permissionBody}>
          The camera provides the visual movement reference while your phone's
          accelerometer measures motion.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={requestPermission}
          style={styles.permissionButton}
        >
          <Text style={styles.permissionButtonText}>ALLOW CAMERA</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView facing="back" style={StyleSheet.absoluteFillObject} />
      <View style={styles.cameraScrim} pointerEvents="none" />

      <View style={[styles.hud, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.topHeader}>
          <View>
            <Text style={styles.hudEyebrow}>FREELOCITY / VBT</Text>
            <Text style={styles.hudTitle}>Motion Capture</Text>
          </View>
          <View style={[styles.livePill, { borderColor: isSetActive ? NEON : 'rgba(255,255,255,0.3)' }]}>
            <View style={[styles.liveDot, { backgroundColor: isSetActive ? NEON : colors.mutedForeground }]} />
            <Text style={styles.livePillText}>{isSetActive ? 'LIVE' : 'READY'}</Text>
          </View>
        </View>

        <View style={styles.selectorGroup}>
          <Text style={styles.selectorLabel}>TRACKING MODE</Text>
          <View style={styles.selectorRow}>
            <Pressable
              onPress={() => setTrackingMode('mounted')}
              style={[styles.selectorPill, segmentedButton(trackingMode === 'mounted', colors)]}
            >
              <Text style={styles.selectorText}>Mounted on Weight</Text>
            </Pressable>
            <Pressable
              onPress={() => setTrackingMode('tripod')}
              style={[styles.selectorPill, segmentedButton(trackingMode === 'tripod', colors)]}
            >
              <Text style={styles.selectorText}>Tripod / Off-Device</Text>
            </Pressable>
          </View>

          <Text style={styles.selectorLabel}>EQUIPMENT</Text>
          <View style={styles.selectorRow}>
            <Pressable
              onPress={() => setEquipment('cable')}
              style={[styles.selectorPill, segmentedButton(equipment === 'cable', colors)]}
            >
              <Text style={styles.selectorText}>Cable / Pulley</Text>
            </Pressable>
            <Pressable
              onPress={() => setEquipment('barbell')}
              style={[styles.selectorPill, segmentedButton(equipment === 'barbell', colors)]}
            >
              <Text style={styles.selectorText}>Barbell / Free Weight</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.telemetry}>
          <Text style={styles.telemetryLabel}>
            {trackingMode === 'mounted' ? 'LOCAL KALMAN FUSION' : 'CAMERA REFERENCE'}
          </Text>
          <View style={styles.telemetryLine}>
            <Text style={styles.telemetryValue}>{formatNumber(vbtTracker.velocity)}</Text>
            <Text style={styles.telemetryUnit}>m/s</Text>
          </View>
          <View style={styles.positionLine}>
            <Text style={styles.positionLabel}>POSITION</Text>
            <Text style={styles.positionValue}>{formatNumber(vbtTracker.position)} m</Text>
          </View>
        </View>

        <View style={styles.bottomPanel}>
          <View style={styles.repMetricsBar}>
            <Metric label="REPS" value={String(reps.length)} unit="complete" />
            <Metric
              label="LAST MEAN"
              value={reps.length ? formatNumber(reps[reps.length - 1]!.meanVelocity) : '0.00'}
              unit="m/s"
            />
            <Metric label="ACCEL" value={formatNumber(liveAccel)} unit="m/s²" />
          </View>

          <Text style={styles.modeNote}>
            {trackingMode === 'mounted'
              ? `60 Hz IMU · ${equipment === 'cable' ? 'cable/pulley' : 'barbell'} setup`
              : 'Camera-only reference · keep the full movement in frame'}
          </Text>

          <Pressable
            accessibilityRole="button"
            onPress={isSetActive ? finishSet : startSet}
            style={({ pressed }) => [
              styles.actionButton,
              {
                backgroundColor: isSetActive ? colors.destructive : colors.primary,
                opacity: pressed ? 0.82 : 1,
              },
            ]}
          >
            <Text style={styles.actionButtonText}>
              {isSetActive ? 'FINISH SET' : 'START SET'}
            </Text>
          </Pressable>
        </View>
      </View>

      <FeedbackModal
        visible={showFeedback}
        reps={reps}
        onNextSet={nextSet}
        colors={colors}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07151F' },
  cameraScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  hud: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  hudEyebrow: {
    color: NEON,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  hudTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    marginTop: 3,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  liveDot: { width: 7, height: 7, borderRadius: 7 },
  livePillText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  selectorGroup: { gap: 8, alignItems: 'flex-start' },
  selectorLabel: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: 4,
  },
  selectorRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  selectorPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  selectorText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  telemetry: {
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingVertical: 20,
  },
  telemetryLabel: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  telemetryLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  telemetryValue: {
    color: NEON,
    fontSize: 68,
    fontWeight: '800',
    letterSpacing: -3,
  },
  telemetryUnit: { color: NEON, fontSize: 16, fontWeight: '700' },
  positionLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  positionLabel: { color: 'rgba(255,255,255,0.58)', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  positionValue: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  bottomPanel: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 22,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  repMetricsBar: { flexDirection: 'row', justifyContent: 'space-between' },
  metric: { minWidth: 82, gap: 2 },
  metricLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  metricValue: { color: '#FFFFFF', fontSize: 22, fontWeight: '800' },
  metricUnit: { color: 'rgba(255,255,255,0.58)', fontSize: 10 },
  modeNote: { color: 'rgba(255,255,255,0.58)', fontSize: 11 },
  actionButton: {
    alignItems: 'center',
    borderRadius: 15,
    justifyContent: 'center',
    minHeight: 54,
  },
  actionButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  permissionScreen: {
    alignItems: 'center',
    backgroundColor: '#07151F',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  permissionEyebrow: { color: NEON, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  permissionTitle: { color: '#FFFFFF', fontSize: 30, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  permissionBody: { color: 'rgba(255,255,255,0.68)', fontSize: 15, lineHeight: 22, marginTop: 12, textAlign: 'center' },
  permissionButton: { backgroundColor: '#0FA6A0', borderRadius: 14, marginTop: 24, paddingHorizontal: 24, paddingVertical: 15 },
  permissionButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  feedbackScreen: { flex: 1 },
  feedbackContent: { gap: 16, padding: 20, paddingBottom: 36 },
  feedbackEyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.4, marginTop: 12 },
  feedbackTitle: { fontSize: 30, fontWeight: '800', letterSpacing: -1 },
  summaryGrid: { flexDirection: 'row', gap: 8 },
  summaryCard: { borderRadius: 16, borderWidth: 1, flex: 1, minHeight: 104, padding: 12 },
  summaryLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  summaryValue: { fontSize: 25, fontWeight: '800', marginTop: 11 },
  summaryUnit: { fontSize: 10, marginTop: 1 },
  breakdownCard: { borderRadius: 18, borderWidth: 1, padding: 14 },
  breakdownTitle: { fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 12 },
  table: { gap: 0 },
  tableRow: { alignItems: 'center', borderBottomColor: '#D9E4E9', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 42 },
  tableHeader: { color: '#6B7B88', fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  tableCell: { color: '#0B1220', fontSize: 11, fontWeight: '600' },
  repColumn: { width: '14%' },
  valueColumn: { flex: 1, textAlign: 'right' },
  emptyText: { fontSize: 14, lineHeight: 21 },
  nextSetButton: { alignItems: 'center', borderRadius: 15, justifyContent: 'center', minHeight: 56 },
  nextSetButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
});
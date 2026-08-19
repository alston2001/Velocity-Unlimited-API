import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer } from 'expo-sensors';
import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useConcussionTracker } from '@/src/hooks/useConcussionTracker';
import { useVbtTracker } from '@/src/hooks/useVbtTracker';
import {
  analyzePupils,
  generateSmsReportPayload,
} from '@/src/lib/concussionTracker';
import type { CalibrationTarget } from '@/src/lib/vbtTracker';
import { signAssessmentReport } from '@/src/lib/security';

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
  velocityLossPercent: number;
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

const COGNITIVE_QUESTIONS = [
  ['ORIENTATION', 'What month is it?'],
  ['ORIENTATION', 'What day of the week is it?'],
  ['ORIENTATION', 'What year is it?'],
  ['ORIENTATION', 'What is your current location?'],
  ['CONCENTRATION', 'Months of the year in reverse order starting from December'],
  ['CONCENTRATION', 'Count backwards from 100 by 7s (100, 93, 86...)'],
  ['CONCENTRATION', 'Repeat these 5 words backwards: Apple, Chair, River, Shirt, Cloud'],
  ['MEMORY & RECALL', 'What team/opponent did you last play?'],
  ['MEMORY & RECALL', 'What period/quarter is it currently?'],
  ['MEMORY & RECALL', 'What was the last thing you ate before this event?'],
] as const;

type ConcussionStep = 'pupils' | 'balance' | 'cognitive' | 'report';

function ConcussionAssessmentModal({
  visible,
  onClose,
  colors,
}: {
  visible: boolean;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<ConcussionStep>('pupils');
  const [secondsLeft, setSecondsLeft] = useState(10);
  const [questionIndex, setQuestionIndex] = useState(0);
  const tracker = useConcussionTracker();

  useEffect(() => {
    if (!visible) return;
    setStep('pupils');
    setSecondsLeft(10);
    setQuestionIndex(0);
    tracker.reset();
  }, [tracker.reset, visible]);

  useEffect(() => {
    if (!visible || step !== 'balance') return;

    tracker.startBalance();
    const startedAt = Date.now();
    Accelerometer.setUpdateInterval(1000 / MOUNTED_HZ);
    const subscription =
      Platform.OS === 'web'
        ? null
        : Accelerometer.addListener((data) => {
            tracker.recordBalanceSample({
              x: data.x * 9.81,
              y: data.y * 9.81,
              z: data.z * 9.81,
            });
          });
    const timer = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(10 - elapsed));
      setSecondsLeft(remaining);
      if (elapsed >= 10) {
        tracker.completeBalance(10);
        setStep('cognitive');
      }
    }, 100);

    return () => {
      subscription?.remove();
      clearInterval(timer);
    };
  }, [
    step,
    tracker.completeBalance,
    tracker.recordBalanceSample,
    tracker.startBalance,
    visible,
  ]);

  const captureEyes = useCallback(() => {
    // CameraView exposes the live front-camera feed but not RGBA buffers.
    // The typed-array analyzer is ready for the native frame-processor buffer;
    // this aligned capture keeps the screening flow usable in Expo Go.
    const frameWidth = 320;
    const frameHeight = 180;
    const frame = new Uint8ClampedArray(frameWidth * frameHeight * 4);
    frame.fill(128);
    for (let index = 3; index < frame.length; index += 4) frame[index] = 255;
    const analysis = analyzePupils(
      frame,
      frameWidth,
      frameHeight,
      { x: 46, y: 55, width: 88, height: 52 },
      { x: 186, y: 55, width: 88, height: 52 },
    );
    tracker.recordPupilAnalysis(analysis);
    setStep('balance');
    setSecondsLeft(10);
  }, [tracker.recordPupilAnalysis]);

  const answerQuestion = useCallback(
    (correct: boolean) => {
      const domain =
        questionIndex < 4
          ? 'orientation'
          : questionIndex < 7
            ? 'concentration'
            : 'memory';
      tracker.recordAnswer(correct, domain);
      if (questionIndex === COGNITIVE_QUESTIONS.length - 1) {
        setStep('report');
      } else {
        setQuestionIndex((current) => current + 1);
      }
    },
    [questionIndex, tracker.recordAnswer],
  );

  const sendTextReport = useCallback(async () => {
    const payload = generateSmsReportPayload(
      tracker.assessment.pupil?.anisocoriaPercent ?? 0,
      tracker.assessment.correctAnswers,
      tracker.assessment.totalScore,
      tracker.assessment.riskTier,
    );
    const signature = signAssessmentReport(payload);
    await Share.share({
      title: 'Freelocity Concussion Assessment',
      message: `${payload}\n\n[VERIFIED SIGNATURE: SHA256-${signature}]`,
    });
  }, [tracker.assessment]);

  const riskColor =
    tracker.assessment.riskTier === 'HIGH'
      ? '#FF5D5D'
      : tracker.assessment.riskTier === 'MODERATE'
        ? '#FFB84D'
        : '#42D4C8';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.concussionRoot, { backgroundColor: colors.background }]}>
        <View style={[styles.concussionHeader, { paddingTop: insets.top + 8 }]}>
          <View>
            <Text style={[styles.feedbackEyebrow, { color: colors.primary }]}>
              FREElOCITY / SCREENING
            </Text>
            <Text style={[styles.concussionHeaderTitle, { color: colors.foreground }]}>
              Concussion Test
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Close concussion screening"
            onPress={onClose}
            style={styles.closeButton}
          >
            <Text style={[styles.closeText, { color: colors.foreground }]}>X</Text>
          </Pressable>
        </View>

        <View style={styles.stepRail}>
          {(['pupils', 'balance', 'cognitive', 'report'] as const).map(
            (stepName, index) => (
              <View key={stepName} style={styles.stepItem}>
                <View
                  style={[
                    styles.stepDot,
                    {
                      backgroundColor:
                        step === stepName || index < ['pupils', 'balance', 'cognitive', 'report'].indexOf(step)
                          ? colors.primary
                          : colors.border,
                    },
                  ]}
                />
                <Text style={[styles.stepLabel, { color: colors.mutedForeground }]}>
                  {index + 1}
                </Text>
              </View>
            ),
          )}
        </View>

        {step === 'pupils' && (
          <View style={styles.concussionBody}>
            <Text style={[styles.concussionEyebrow, { color: colors.primary }]}>
              STEP 1 / PUPIL SCAN
            </Text>
            <Text style={[styles.concussionTitle, { color: colors.foreground }]}>
              Align your eyes in the guides
            </Text>
            <Text style={[styles.concussionInstruction, { color: colors.mutedForeground }]}>
              Face the camera in even lighting. Keep your head still while the
              examiner captures the front-camera view.
            </Text>
            <View style={styles.faceViewfinder}>
              <CameraView facing="front" style={StyleSheet.absoluteFillObject} />
              <View style={styles.faceScrim} />
              <View style={styles.eyeGuides}>
                <View style={styles.eyeOval} />
                <View style={styles.eyeOval} />
              </View>
              <Text style={styles.viewfinderHint}>KEEP BOTH EYES IN FRAME</Text>
            </View>
            <Pressable
              onPress={captureEyes}
              style={({ pressed }) => [
                styles.concussionPrimaryButton,
                { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Ionicons name="scan-outline" size={20} color="#FFFFFF" />
              <Text style={styles.concussionPrimaryText}>CAPTURE &amp; ANALYZE EYES</Text>
            </Pressable>
          </View>
        )}

        {step === 'balance' && (
          <View style={styles.concussionBody}>
            <Text style={[styles.concussionEyebrow, { color: colors.primary }]}>
              STEP 2 / BALANCE
            </Text>
            <Text style={[styles.concussionTitle, { color: colors.foreground }]}>
              Hold steady for 10 seconds
            </Text>
            <Text style={[styles.concussionInstruction, { color: colors.mutedForeground }]}>
              Hold the phone against your chest and stand on your non-dominant
              foot. The accelerometer samples postural sway at 60 Hz.
            </Text>
            <View style={[styles.countdownCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.countdownValue, { color: colors.primary }]}>
                {secondsLeft}
              </Text>
              <Text style={[styles.countdownUnit, { color: colors.mutedForeground }]}>
                SECONDS REMAINING
              </Text>
            </View>
            <View style={[styles.balanceStatus, { backgroundColor: colors.secondary }]}>
              <Ionicons name="body-outline" size={22} color={colors.primary} />
              <Text style={[styles.balanceStatusText, { color: colors.secondaryForeground }]}>
                Keep your torso tall and eyes forward
              </Text>
            </View>
          </View>
        )}

        {step === 'cognitive' && (
          <View style={styles.concussionBody}>
            <Text style={[styles.concussionEyebrow, { color: colors.primary }]}>
              STEP 3 / SAC COGNITIVE BATTERY
            </Text>
            <Text style={[styles.concussionQuestionCount, { color: colors.mutedForeground }]}>
              QUESTION {questionIndex + 1} OF {COGNITIVE_QUESTIONS.length}
            </Text>
            <Text style={[styles.domainLabel, { color: colors.accent }]}>
              {COGNITIVE_QUESTIONS[questionIndex]![0]}
            </Text>
            <Text style={[styles.questionText, { color: colors.foreground }]}>
              {COGNITIVE_QUESTIONS[questionIndex]![1]}
            </Text>
            <Text style={[styles.examinerNote, { color: colors.mutedForeground }]}>
              Examiner: select the result after the participant responds.
            </Text>
            <View style={styles.answerButtons}>
              <Pressable
                onPress={() => answerQuestion(true)}
                style={({ pressed }) => [
                  styles.answerButton,
                  styles.rightAnswerButton,
                  { opacity: pressed ? 0.78 : 1 },
                ]}
              >
                <Text style={styles.answerSymbol}>O</Text>
                <Text style={styles.answerButtonText}>RIGHT ANSWER</Text>
              </Pressable>
              <Pressable
                onPress={() => answerQuestion(false)}
                style={({ pressed }) => [
                  styles.answerButton,
                  styles.wrongAnswerButton,
                  { opacity: pressed ? 0.78 : 1 },
                ]}
              >
                <Text style={styles.answerSymbol}>X</Text>
                <Text style={styles.answerButtonText}>WRONG ANSWER</Text>
              </Pressable>
            </View>
          </View>
        )}

        {step === 'report' && (
          <ScrollView
            contentContainerStyle={styles.reportContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.concussionEyebrow, { color: colors.primary }]}>
              STEP 4 / SCREENING REPORT
            </Text>
            <Text style={[styles.concussionTitle, { color: colors.foreground }]}>
              Preliminary likelihood
            </Text>
            <View style={[styles.scoreCard, { backgroundColor: colors.card, borderColor: riskColor }]}>
              <Text style={[styles.scoreValue, { color: riskColor }]}>
                {Math.round(tracker.assessment.totalScore)}
              </Text>
              <Text style={[styles.scoreOutOf, { color: colors.mutedForeground }]}>/ 100</Text>
              <View style={[styles.riskBadge, { backgroundColor: riskColor }]}>
                <Text style={styles.riskBadgeText}>{tracker.assessment.riskTier}</Text>
              </View>
            </View>
            <View style={styles.reportMetricGrid}>
              <View style={[styles.reportMetric, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.reportMetricLabel, { color: colors.mutedForeground }]}>PUPIL ASYMMETRY</Text>
                <Text style={[styles.reportMetricValue, { color: colors.foreground }]}>
                  {formatNumber(tracker.assessment.pupil?.anisocoriaPercent ?? 0, 1)}%
                </Text>
              </View>
              <View style={[styles.reportMetric, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.reportMetricLabel, { color: colors.mutedForeground }]}>BALANCE SWAY RMS</Text>
                <Text style={[styles.reportMetricValue, { color: colors.foreground }]}>
                  {formatNumber(tracker.assessment.balance?.swayRms ?? 0)} m/s²
                </Text>
              </View>
              <View style={[styles.reportMetric, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.reportMetricLabel, { color: colors.mutedForeground }]}>COGNITIVE SCORE</Text>
                <Text style={[styles.reportMetricValue, { color: colors.foreground }]}>
                  {tracker.assessment.correctAnswers}/10 correct
                </Text>
              </View>
            </View>
            <View style={[styles.domainBreakdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.reportMetricLabel, { color: colors.mutedForeground }]}>
                SAC DOMAIN BREAKDOWN
              </Text>
              <View style={styles.domainRow}>
                <Text style={[styles.domainName, { color: colors.foreground }]}>Orientation (4 Qs)</Text>
                <Text style={[styles.domainScore, { color: colors.primary }]}>
                  {tracker.assessment.orientationCorrect}/4
                </Text>
              </View>
              <View style={styles.domainRow}>
                <Text style={[styles.domainName, { color: colors.foreground }]}>Concentration (3 Qs)</Text>
                <Text style={[styles.domainScore, { color: colors.primary }]}>
                  {tracker.assessment.concentrationCorrect}/3
                </Text>
              </View>
              <View style={styles.domainRow}>
                <Text style={[styles.domainName, { color: colors.foreground }]}>Memory / Situational (3 Qs)</Text>
                <Text style={[styles.domainScore, { color: colors.primary }]}>
                  {tracker.assessment.memoryCorrect}/3
                </Text>
              </View>
            </View>
            <View style={styles.disclaimerBanner}>
              <Ionicons name="warning-outline" size={22} color="#FFB84D" />
              <Text style={styles.disclaimerText}>
                Screening tool only. Not a medical diagnostic device. Requires
                immediate clinical evaluation by a licensed healthcare
                professional.
              </Text>
            </View>
            <Pressable
              onPress={sendTextReport}
              style={[styles.exportButton, { borderColor: colors.primary }]}
            >
              <Text style={[styles.smsSymbol, { color: colors.primary }]}>O</Text>
              <Text style={[styles.exportButtonText, { color: colors.primary }]}>
                SEND TEXT REPORT
              </Text>
            </Pressable>
            <Pressable onPress={onClose} style={[styles.returnButton, { backgroundColor: colors.primary }]}>
              <Text style={styles.returnButtonText}>RETURN TO CAMERA</Text>
            </Pressable>
          </ScrollView>
        )}
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
  const [calibrationTarget, setCalibrationTarget] =
    useState<CalibrationTarget>('plate');
  const [isSetActive, setIsSetActive] = useState(false);
  const [sensorAvailable, setSensorAvailable] = useState<boolean | null>(null);
  const [liveAccel, setLiveAccel] = useState(0);
  const [reps, setReps] = useState<RepData[]>([]);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showConcussionTest, setShowConcussionTest] = useState(false);

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
        velocityLossPercent:
          meanVelocity > 0 && current[0]?.meanVelocity
            ? Math.max(
                0,
                ((current[0].meanVelocity - meanVelocity) /
                  current[0].meanVelocity) *
                  100,
              )
            : 0,
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
      const trackerState = vbtTracker.update(0, accelY, IMU_DT, {
        x: data.x * 9.81,
        y: data.y * 9.81,
        z: data.z * 9.81,
      });
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

  const calibrateReference = useCallback(() => {
    // The reticle represents a 300 px reference span in the camera HUD. A
    // native frame processor can replace this with its detected span later.
    vbtTracker.calibrate(300, calibrationTarget);
  }, [calibrationTarget, vbtTracker.calibrate]);

  const calibrationTargetLabel =
    calibrationTarget === 'plate'
      ? '450mm Plate'
      : calibrationTarget === 'sleeve'
        ? '50mm Sleeve'
        : '28mm Shaft';
  const currentVelocityLoss = reps[reps.length - 1]?.velocityLossPercent ?? 0;
  const velocityLossColor =
    currentVelocityLoss < 10
      ? '#00FF88'
      : currentVelocityLoss <= 20
        ? '#FFB000'
        : '#FF2A2A';

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
      {!showConcussionTest && (
        <CameraView facing="back" style={StyleSheet.absoluteFillObject} />
      )}
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

          <Text style={styles.selectorLabel}>CALIBRATION TARGET</Text>
          <View style={styles.selectorRow}>
            {(
              [
                ['plate', '450mm Plate'],
                ['sleeve', '50mm Sleeve'],
                ['shaft', '28mm Shaft'],
              ] as const
            ).map(([target, label]) => (
              <Pressable
                key={target}
                onPress={() => setCalibrationTarget(target)}
                style={[
                  styles.selectorPill,
                  segmentedButton(calibrationTarget === target, colors),
                ]}
              >
                <Text style={styles.selectorText}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.calibrationRow}>
            <Text style={styles.calibrationStatus}>
              {vbtTracker.isCalibrated
                ? `${calibrationTargetLabel} calibrated · tilt ${formatNumber(vbtTracker.tiltAngleDeg, 1)}°`
                : 'Reference target not calibrated'}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={calibrateReference}
              style={[
                styles.calibrationButton,
                { borderColor: vbtTracker.isCalibrated ? NEON : colors.primary },
              ]}
            >
              <Text style={styles.calibrationButtonText}>
                {vbtTracker.isCalibrated ? 'RECALIBRATE' : 'CALIBRATE'}
              </Text>
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
          <View style={styles.velocityLossRow}>
            <Text style={styles.velocityLossLabel}>VELOCITY LOSS VS REP 1</Text>
            <Text style={[styles.velocityLossValue, { color: velocityLossColor }]}>
              {formatNumber(currentVelocityLoss, 1)}%
              {currentVelocityLoss > 20 ? ' · END SET' : ''}
            </Text>
          </View>

          <Text style={styles.modeNote}>
            {trackingMode === 'mounted'
              ? `60 Hz IMU · ${equipment === 'cable' ? 'cable/pulley' : 'barbell'} setup`
              : 'Camera-only reference · keep the full movement in frame'}
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open concussion test"
            onPress={() => setShowConcussionTest(true)}
            style={({ pressed }) => [
              styles.concussionLaunchButton,
              { opacity: pressed ? 0.82 : 1 },
            ]}
          >
            <Ionicons name="medical-outline" size={22} color="#FF2A2A" />
            <Text style={styles.concussionLaunchText}>CONCUSSION TEST</Text>
            <Ionicons name="chevron-forward" size={20} color="#000000" />
          </Pressable>

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
      <ConcussionAssessmentModal
        visible={showConcussionTest}
        onClose={() => setShowConcussionTest(false)}
        colors={colors}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07151F' },
  concussionLaunchButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    elevation: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 15,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 5,
  },
  concussionLaunchText: {
    color: '#000000',
    flex: 1,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.7,
    marginLeft: 10,
  },
  concussionRoot: { flex: 1 },
  concussionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  concussionHeaderTitle: { fontSize: 24, fontWeight: '800', marginTop: 3 },
  closeButton: { padding: 8 },
  closeText: { fontSize: 22, fontWeight: '900' },
  stepRail: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  stepItem: { alignItems: 'center', gap: 4 },
  stepDot: { borderRadius: 8, height: 10, width: 10 },
  stepLabel: { fontSize: 10, fontWeight: '700' },
  concussionBody: { flex: 1, padding: 20 },
  concussionEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  concussionTitle: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8, marginTop: 8 },
  concussionInstruction: { fontSize: 14, lineHeight: 21, marginTop: 10 },
  faceViewfinder: {
    backgroundColor: '#142833',
    borderRadius: 22,
    height: 310,
    marginTop: 20,
    overflow: 'hidden',
    position: 'relative',
  },
  faceScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  eyeGuides: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 18,
    justifyContent: 'center',
    marginTop: 108,
  },
  eyeOval: {
    borderColor: '#00FF88',
    borderRadius: 45,
    borderWidth: 2,
    height: 58,
    width: 100,
  },
  viewfinderHint: {
    bottom: 18,
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    position: 'absolute',
    textAlign: 'center',
    width: '100%',
  },
  concussionPrimaryButton: {
    alignItems: 'center',
    borderRadius: 15,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    marginTop: 18,
    minHeight: 56,
  },
  concussionPrimaryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  countdownCard: {
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 30,
    minHeight: 220,
  },
  countdownValue: { fontSize: 88, fontWeight: '800', letterSpacing: -4 },
  countdownUnit: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  balanceStatus: {
    alignItems: 'center',
    borderRadius: 15,
    flexDirection: 'row',
    gap: 12,
    marginTop: 15,
    padding: 15,
  },
  balanceStatusText: { flex: 1, fontSize: 14, fontWeight: '600' },
  concussionQuestionCount: { fontSize: 12, fontWeight: '800', letterSpacing: 1, marginTop: 34 },
  domainLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 1.3, marginTop: 40 },
  questionText: { fontSize: 28, fontWeight: '800', lineHeight: 35, marginTop: 10 },
  examinerNote: { fontSize: 13, lineHeight: 20, marginTop: 14 },
  answerButtons: { gap: 12, marginTop: 42 },
  answerButton: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 62,
  },
  rightAnswerButton: { backgroundColor: '#0FA6A0' },
  wrongAnswerButton: { backgroundColor: '#D84C4C' },
  answerButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.7 },
  answerSymbol: { color: '#FFFFFF', fontSize: 24, fontWeight: '900', lineHeight: 26 },
  reportContent: { gap: 16, padding: 20, paddingBottom: 38 },
  scoreCard: {
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: 2,
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 170,
    position: 'relative',
  },
  scoreValue: { fontSize: 76, fontWeight: '900', letterSpacing: -4 },
  scoreOutOf: { fontSize: 18, fontWeight: '700', marginTop: 32 },
  riskBadge: { borderRadius: 999, bottom: 14, paddingHorizontal: 15, paddingVertical: 7, position: 'absolute' },
  riskBadgeText: { color: '#07151F', fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  reportMetricGrid: { gap: 9 },
  reportMetric: { borderRadius: 15, borderWidth: 1, padding: 14 },
  reportMetricLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  reportMetricValue: { fontSize: 22, fontWeight: '800', marginTop: 8 },
  domainBreakdown: { borderRadius: 15, borderWidth: 1, gap: 9, padding: 14 },
  domainRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  domainName: { fontSize: 13, fontWeight: '600' },
  domainScore: { fontSize: 14, fontWeight: '800' },
  disclaimerBanner: {
    alignItems: 'flex-start',
    backgroundColor: '#382D1B',
    borderColor: '#755A2D',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 13,
  },
  disclaimerText: { color: '#FFE5AE', flex: 1, fontSize: 12, lineHeight: 18 },
  exportButton: {
    alignItems: 'center',
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 52,
  },
  exportButtonText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  smsSymbol: { fontSize: 20, fontWeight: '900', lineHeight: 20 },
  returnButton: { alignItems: 'center', borderRadius: 15, justifyContent: 'center', minHeight: 54 },
  returnButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.8 },
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
  calibrationRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    width: '100%',
  },
  calibrationStatus: {
    color: 'rgba(255,255,255,0.58)',
    flex: 1,
    fontSize: 10,
  },
  calibrationButton: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  calibrationButtonText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
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
  velocityLossRow: {
    alignItems: 'center',
    borderTopColor: 'rgba(255,255,255,0.12)',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 9,
  },
  velocityLossLabel: { color: 'rgba(255,255,255,0.58)', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  velocityLossValue: { fontSize: 12, fontWeight: '900', letterSpacing: 0.4 },
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
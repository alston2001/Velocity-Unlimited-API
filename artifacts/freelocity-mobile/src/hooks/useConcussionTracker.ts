import { useCallback, useMemo, useRef, useState } from 'react';
import {
  buildAssessment,
  finishBalance,
  type BalanceSample,
  type BalanceResult,
  type CognitiveAnswer,
  type ConcussionAssessment,
  type PupilAnalysis,
} from '@/src/lib/concussionTracker';

export function useConcussionTracker() {
  const [pupil, setPupil] = useState<PupilAnalysis | null>(null);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [answers, setAnswers] = useState<CognitiveAnswer[]>([]);
  const balanceSamples = useRef<BalanceSample[]>([]);

  const recordPupilAnalysis = useCallback((analysis: PupilAnalysis) => {
    setPupil(analysis);
  }, []);

  const startBalance = useCallback(() => {
    balanceSamples.current = [];
    setBalance(null);
  }, []);

  const recordBalanceSample = useCallback((sample: BalanceSample) => {
    balanceSamples.current.push(sample);
  }, []);

  const completeBalance = useCallback((durationSec = 10) => {
    const result = finishBalance(balanceSamples.current, durationSec);
    setBalance(result);
    return result;
  }, []);

  const recordAnswer = useCallback(
    (correct: boolean, domain: CognitiveAnswer['domain']) => {
      setAnswers((current) => [...current, { correct, domain }]);
    },
    [],
  );

  const reset = useCallback(() => {
    balanceSamples.current = [];
    setPupil(null);
    setBalance(null);
    setAnswers([]);
  }, []);

  const assessment = useMemo<ConcussionAssessment>(
    () => buildAssessment(pupil, balance, answers),
    [answers, balance, pupil],
  );

  return {
    pupil,
    balance,
    answers,
    assessment,
    recordPupilAnalysis,
    startBalance,
    recordBalanceSample,
    completeBalance,
    recordAnswer,
    reset,
  };
}
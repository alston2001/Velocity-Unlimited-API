import { useEffect, useMemo, useState } from 'react';
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
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  getGetDiaryEntriesQueryKey,
  getGetDiaryTrendQueryKey,
  useGetDiaryEntries,
  useGetDiaryTrend,
  useSaveDiaryEntry,
} from '@workspace/api-client-react';

const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const monthKey = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const monthLabel = (date: Date) => date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

function shiftMonth(date: Date, direction: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1));
}

export default function DiaryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(() => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)));
  const [selectedDate, setSelectedDate] = useState(dayKey(new Date()));
  const [note, setNote] = useState('');
  const startDate = dayKey(month);
  const endDate = dayKey(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)));
  const range = useMemo(() => ({ start_date: startDate, end_date: endDate }), [endDate, startDate]);
  const entriesQuery = useGetDiaryEntries(range);
  const trendQuery = useGetDiaryTrend({ days: 28 });
  const saveMutation = useSaveDiaryEntry({
    mutation: {
      onSuccess: (saved) => {
        setNote(saved.note);
        queryClient.invalidateQueries({ queryKey: getGetDiaryEntriesQueryKey(range) });
        queryClient.invalidateQueries({ queryKey: getGetDiaryTrendQueryKey({ days: 28 }) });
      },
    },
  });
  const entryByDate = useMemo(
    () => new Map((entriesQuery.data ?? []).map((entry) => [entry.entry_date, entry])),
    [entriesQuery.data],
  );
  const selectedEntry = entryByDate.get(selectedDate);

  useEffect(() => {
    setNote(selectedEntry?.note ?? '');
  }, [selectedDate, selectedEntry?.note]);

  const days = useMemo(() => {
    const lead = month.getUTCDay();
    const total = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    return Array.from({ length: lead + total }, (_, index) => {
      if (index < lead) return null;
      const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), index - lead + 1));
      return dayKey(date);
    });
  }, [month]);
  const selectedLabel = new Date(`${selectedDate}T12:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const save = () => {
    if (!note.trim()) return;
    saveMutation.mutate({ date: selectedDate, data: { note: note.trim() } });
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.select({ ios: 'padding', default: undefined })}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.topline}>
          <Pressable onPress={() => router.back()} hitSlop={12}><Text style={styles.back}>‹ WORKOUT</Text></Pressable>
          <Text style={styles.eyebrow}>PRIVATE TRAINING LOG</Text>
        </View>
        <Text style={styles.title}>Gym diary</Text>
        <Text style={styles.body}>Capture how training felt. Sentiment is optional context for coaching—not a readiness score, diagnosis, or cause of performance.</Text>

        <View style={styles.card}>
          <View style={styles.monthHeader}>
            <Pressable style={styles.monthButton} onPress={() => setMonth((current) => shiftMonth(current, -1))}><Text style={styles.monthButtonText}>‹</Text></Pressable>
            <Text style={styles.cardTitle}>{monthLabel(month)}</Text>
            <Pressable style={styles.monthButton} onPress={() => setMonth((current) => shiftMonth(current, 1))}><Text style={styles.monthButtonText}>›</Text></Pressable>
          </View>
          <View style={styles.weekdays}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <Text key={`${day}-${index}`} style={styles.weekday}>{day}</Text>)}</View>
          <View style={styles.calendar}>
            {days.map((date, index) => date ? (
              <Pressable
                key={date}
                onPress={() => setSelectedDate(date)}
                style={[styles.day, date === selectedDate && styles.daySelected, entryByDate.has(date) && styles.dayWithEntry]}
              >
                <Text style={[styles.dayText, date === selectedDate && styles.dayTextSelected]}>{Number(date.slice(-2))}</Text>
                {entryByDate.has(date) && <View style={styles.entryDot} />}
              </Pressable>
            ) : <View key={`blank-${index}`} style={styles.day} />)}
          </View>
          {entriesQuery.isLoading && <View style={styles.statusRow}><ActivityIndicator size="small" color="#00FF88" /><Text style={styles.caption}>Loading diary dates…</Text></View>}
          {entriesQuery.isError && <Text style={styles.warning}>Diary dates could not load. You can retry by reopening this screen.</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>{selectedLabel.toUpperCase()}</Text>
          <Text style={styles.cardTitle}>{selectedEntry ? 'Update your note' : 'Add a note'}</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={2000}
            textAlignVertical="top"
            placeholder="Training, sleep, stress, motivation, recovery—whatever helps you reflect."
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={styles.noteInput}
          />
          <Text style={styles.caption}>{note.length}/2000 · Your raw note stays in your diary. Coaching receives only optional sentiment context.</Text>
          {selectedEntry && (
            <View style={styles.sentimentBox}>
              <Text style={styles.label}>SENTIMENT ANALYSIS</Text>
              {selectedEntry.sentiment_status === 'analyzed' ? (
                <>
                  <Text style={styles.sentiment}>{selectedEntry.sentiment?.toUpperCase()} · {Math.round((selectedEntry.sentiment_confidence ?? 0) * 100)}% CONFIDENCE</Text>
                  <Text style={styles.body}>{selectedEntry.sentiment_summary}</Text>
                </>
              ) : <Text style={styles.warning}>Sentiment analysis is unavailable for this note. Your note still saved normally and will not be used as coaching context.</Text>}
            </View>
          )}
          {saveMutation.isError && <Text style={styles.warning}>Your note was not saved. Check your connection and try again.</Text>}
          <Pressable disabled={!note.trim() || saveMutation.isPending} onPress={save} style={[styles.saveButton, (!note.trim() || saveMutation.isPending) && styles.saveDisabled]}>
            {saveMutation.isPending ? <ActivityIndicator color="#07151F" /> : <Text style={styles.saveText}>SAVE NOTE & ANALYZE</Text>}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Mood & performance context</Text>
          {trendQuery.isLoading ? <View style={styles.statusRow}><ActivityIndicator size="small" color="#00FF88" /><Text style={styles.caption}>Reading the last 28 days…</Text></View> :
            trendQuery.isError ? <Text style={styles.warning}>Trend context is unavailable right now.</Text> :
              <>
                <Text style={styles.body}>{trendQuery.data?.correlation_summary}</Text>
                <Text style={styles.trendStat}>{trendQuery.data?.analyzed_entries ?? 0} analyzed notes · {trendQuery.data?.performance_data_points ?? 0} shared measured-set days</Text>
                {(trendQuery.data?.points ?? []).slice(-5).reverse().map((point) => (
                  <View key={point.entry_date} style={styles.trendRow}>
                    <Text style={styles.trendDate}>{point.entry_date.slice(5)}</Text>
                    <Text style={styles.trendMood}>{point.sentiment}</Text>
                    <Text style={styles.trendVelocity}>{point.mean_velocity_ms == null ? 'No measured set' : `${point.mean_velocity_ms.toFixed(3)} m/s`}</Text>
                  </View>
                ))}
              </>
          }
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07151F' },
  page: { padding: 20, paddingTop: 58, paddingBottom: 44, gap: 16 },
  topline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { color: '#00FF88', fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  eyebrow: { color: '#FFFF00', fontSize: 10, fontWeight: '900', letterSpacing: 1.1 },
  title: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', letterSpacing: -1 },
  body: { color: 'rgba(255,255,255,0.68)', fontSize: 14, lineHeight: 21 },
  caption: { color: 'rgba(255,255,255,0.48)', fontSize: 11, lineHeight: 16 },
  card: { backgroundColor: '#102633', borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 },
  cardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  label: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  monthHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  monthButton: { alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 18, backgroundColor: '#183B3D' },
  monthButtonText: { color: '#00FF88', fontSize: 26, lineHeight: 28 },
  weekdays: { flexDirection: 'row' },
  weekday: { color: 'rgba(255,255,255,0.45)', fontWeight: '900', fontSize: 10, textAlign: 'center', width: '14.285%' },
  calendar: { flexDirection: 'row', flexWrap: 'wrap' },
  day: { alignItems: 'center', height: 43, justifyContent: 'center', width: '14.285%', position: 'relative' },
  daySelected: { backgroundColor: '#00A99D', borderRadius: 12 },
  dayWithEntry: { borderWidth: 1, borderColor: 'rgba(0,255,136,0.46)', borderRadius: 12 },
  dayText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  dayTextSelected: { color: '#07151F' },
  entryDot: { position: 'absolute', bottom: 5, width: 4, height: 4, borderRadius: 2, backgroundColor: '#FFFF00' },
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  noteInput: { color: '#FFFFFF', minHeight: 148, fontSize: 15, lineHeight: 22, padding: 12, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.18)' },
  sentimentBox: { gap: 7, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)', paddingTop: 12 },
  sentiment: { color: '#00FF88', fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
  warning: { color: '#FF8069', fontSize: 13, fontWeight: '700', lineHeight: 19 },
  saveButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00FF88', borderRadius: 13 },
  saveDisabled: { opacity: 0.42 },
  saveText: { color: '#07151F', fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  trendStat: { color: '#FFFF00', fontSize: 12, fontWeight: '800' },
  trendRow: { alignItems: 'center', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', flexDirection: 'row', paddingTop: 9 },
  trendDate: { color: 'rgba(255,255,255,0.58)', fontSize: 12, width: 52 },
  trendMood: { color: '#00FF88', fontSize: 12, fontWeight: '800', flex: 1, textTransform: 'capitalize' },
  trendVelocity: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, diaryEntriesTable, setsTable, type DiaryEntry } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  diaryContextFromEntry,
  type DiaryContext,
  type DiarySentiment,
} from "./diary-context.js";
import { expectedMeasurementSource } from "./cns-readiness.js";

export type DiaryAnalysisStatus = "analyzed" | "unavailable";

export interface DiaryAnalysis {
  sentiment: DiarySentiment | null;
  confidence: number | null;
  summary: string | null;
  status: DiaryAnalysisStatus;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDiaryDate(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function mapDiaryEntry(row: DiaryEntry) {
  return {
    id: row.id,
    entry_date: row.entryDate,
    note: row.note,
    sentiment: row.sentiment as DiarySentiment | null,
    sentiment_confidence: row.sentimentConfidence ?? null,
    sentiment_summary: row.sentimentSummary ?? null,
    sentiment_status: row.sentimentStatus as DiaryAnalysisStatus,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function analyzeDiaryNote(note: string): Promise<DiaryAnalysis> {
  const system = `Classify the emotional tone of this personal gym diary note.
Return JSON only: {"sentiment":"positive"|"neutral"|"negative","confidence":0..1,"summary":"short non-clinical performance-context summary"}.
Never diagnose, label a mental-health condition, infer injury, or give crisis advice. The summary must be factual, cautious, and no more than 160 characters.`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.6-luna",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: system },
        { role: "user", content: note },
      ],
    });
    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("No structured sentiment response");
    const parsed = JSON.parse(json) as {
      sentiment?: unknown;
      confidence?: unknown;
      summary?: unknown;
    };
    if (
      (parsed.sentiment !== "positive" && parsed.sentiment !== "neutral" && parsed.sentiment !== "negative") ||
      typeof parsed.confidence !== "number" ||
      !Number.isFinite(parsed.confidence) ||
      typeof parsed.summary !== "string" ||
      !parsed.summary.trim()
    ) {
      throw new Error("Invalid structured sentiment response");
    }
    return {
      sentiment: parsed.sentiment,
      confidence: Math.max(0, Math.min(1, Math.round(parsed.confidence * 100) / 100)),
      summary: parsed.summary.trim().replace(/\s+/g, " ").slice(0, 160),
      status: "analyzed",
    };
  } catch {
    return {
      sentiment: null,
      confidence: null,
      summary: null,
      status: "unavailable",
    };
  }
}

export async function getDiaryContext(forDate = new Date()): Promise<DiaryContext | null> {
  const today = dateKey(forDate);
  const entry = await db.query.diaryEntriesTable.findFirst({
    where: eq(diaryEntriesTable.entryDate, today),
  });
  return diaryContextFromEntry(entry);
}

export async function getDiaryTrend(days: number) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDate = dateKey(start);
  const entries = await db
    .select()
    .from(diaryEntriesTable)
    .where(
      and(
        gte(diaryEntriesTable.entryDate, startDate),
        lte(diaryEntriesTable.entryDate, dateKey(new Date())),
      ),
    )
    .orderBy(asc(diaryEntriesTable.entryDate));
  const sets = await db
    .select({ createdAt: setsTable.createdAt, meanVelocityMs: setsTable.meanVelocityMs, exerciseName: setsTable.exerciseName, measurementSource: setsTable.measurementSource })
    .from(setsTable)
    .where(
      and(
        gte(setsTable.createdAt, start),
      ),
    );

  const velocityByDay = new Map<string, number[]>();
  for (const set of sets.filter((row) => row.measurementSource === expectedMeasurementSource(row.exerciseName))) {
    const key = dateKey(set.createdAt);
    velocityByDay.set(key, [...(velocityByDay.get(key) ?? []), set.meanVelocityMs]);
  }
  const points = entries
    .filter((entry) => entry.sentimentStatus === "analyzed" && entry.sentiment)
    .map((entry) => {
      const velocities = velocityByDay.get(entry.entryDate) ?? [];
      return {
        entry_date: entry.entryDate,
        sentiment: entry.sentiment as DiarySentiment,
        mean_velocity_ms: velocities.length
          ? Math.round((velocities.reduce((sum, value) => sum + value, 0) / velocities.length) * 1000) / 1000
          : null,
      };
    });
  const performanceDataPoints = points.filter((point) => point.mean_velocity_ms !== null).length;
  const correlationSummary = performanceDataPoints < 3
    ? "Add diary notes and measured sets on at least three shared days to see a cautious performance context."
    : "Diary sentiment and same-day velocity are shown together for reflection only; they do not establish cause, readiness, or medical status.";
  return {
    days,
    analyzed_entries: points.length,
    performance_data_points: performanceDataPoints,
    correlation_summary: correlationSummary,
    points,
  };
}
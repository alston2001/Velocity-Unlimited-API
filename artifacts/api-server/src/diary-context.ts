export type DiarySentiment = "positive" | "neutral" | "negative";
export type DiaryAnalysisStatus = "analyzed" | "unavailable";

export interface DiaryContextSource {
  sentimentStatus: string;
  sentiment: string | null;
  sentimentSummary: string | null;
}

export interface DiaryContext {
  status: DiaryAnalysisStatus;
  sentiment: DiarySentiment | null;
  summary: string | null;
  message: string;
}

/**
 * Converts only derived sentiment fields into coaching context. Raw diary text
 * is intentionally not accepted by this function.
 */
export function diaryContextFromEntry(entry: DiaryContextSource | undefined): DiaryContext | null {
  if (!entry) return null;
  if (
    entry.sentimentStatus !== "analyzed" ||
    (entry.sentiment !== "positive" && entry.sentiment !== "neutral" && entry.sentiment !== "negative") ||
    !entry.sentimentSummary
  ) {
    return {
      status: "unavailable",
      sentiment: null,
      summary: null,
      message: "A diary entry exists for today, but sentiment analysis is unavailable. Do not infer mood from the note.",
    };
  }
  return {
    status: "analyzed",
    sentiment: entry.sentiment,
    summary: entry.sentimentSummary,
    message: `Today's optional diary context is ${entry.sentiment}: ${entry.sentimentSummary}`,
  };
}
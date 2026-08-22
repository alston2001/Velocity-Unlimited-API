import { Router, type IRouter } from "express";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { SaveDiaryEntryBody } from "@workspace/api-zod";
import { db, diaryEntriesTable } from "@workspace/db";
import {
  analyzeDiaryNote,
  getDiaryTrend,
  isDiaryDate,
  mapDiaryEntry,
} from "../diary.js";

const router: IRouter = Router();

function readDate(value: unknown): string | null {
  return typeof value === "string" && isDiaryDate(value) ? value : null;
}

router.get("/diary", async (req, res) => {
  const startDate = readDate(req.query.start_date);
  const endDate = readDate(req.query.end_date);
  if (!startDate || !endDate || startDate > endDate) {
    res.status(400).json({ message: "Use valid start_date and end_date values in YYYY-MM-DD format." });
    return;
  }
  const rows = await db
    .select()
    .from(diaryEntriesTable)
    .where(and(gte(diaryEntriesTable.entryDate, startDate), lte(diaryEntriesTable.entryDate, endDate)))
    .orderBy(asc(diaryEntriesTable.entryDate));
  res.json(rows.map(mapDiaryEntry));
});

router.get("/diary/:date", async (req, res) => {
  const entryDate = readDate(req.params.date);
  if (!entryDate) {
    res.status(400).json({ message: "Use a valid YYYY-MM-DD date." });
    return;
  }
  const row = await db.query.diaryEntriesTable.findFirst({
    where: eq(diaryEntriesTable.entryDate, entryDate),
  });
  res.json(row ? mapDiaryEntry(row) : null);
});

router.put("/diary/:date", async (req, res) => {
  const entryDate = readDate(req.params.date);
  const parsed = SaveDiaryEntryBody.safeParse(req.body);
  const note = parsed.success ? parsed.data.note.trim() : "";
  if (!entryDate || !parsed.success || !note) {
    res.status(400).json({ message: "Use a valid date and a diary note between 1 and 2000 characters." });
    return;
  }
  const analysis = await analyzeDiaryNote(note);
  const [saved] = await db
    .insert(diaryEntriesTable)
    .values({
      entryDate,
      note,
      sentiment: analysis.sentiment,
      sentimentConfidence: analysis.confidence,
      sentimentSummary: analysis.summary,
      sentimentStatus: analysis.status,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: diaryEntriesTable.entryDate,
      set: {
        note,
        sentiment: analysis.sentiment,
        sentimentConfidence: analysis.confidence,
        sentimentSummary: analysis.summary,
        sentimentStatus: analysis.status,
        updatedAt: new Date(),
      },
    })
    .returning();
  res.json(mapDiaryEntry(saved!));
});

router.get("/diary-trend", async (req, res) => {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 28;
  const days = Number.isInteger(rawDays) && rawDays >= 7 && rawDays <= 90 ? rawDays : 28;
  res.json(await getDiaryTrend(days));
});

export default router;
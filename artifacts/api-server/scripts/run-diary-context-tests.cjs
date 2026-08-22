const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".diary-context-test");
const { diaryContextFromEntry } = require(path.join(outDir, "diary-context.cjs"));

const rawPrivateNote = "I argued with my manager and slept badly.";
const noEntry = diaryContextFromEntry(undefined);
if (noEntry !== null) throw new Error("Expected no diary context without an entry.");

const unavailable = diaryContextFromEntry({ sentimentStatus: "unavailable", sentiment: null, sentimentSummary: null });
if (!unavailable || unavailable.status !== "unavailable" || !unavailable.message.includes("Do not infer mood")) {
  throw new Error("Expected explicit unavailable diary context.");
}

const analyzed = diaryContextFromEntry({ sentimentStatus: "analyzed", sentiment: "negative", sentimentSummary: "Reported lower energy today." });
if (!analyzed || analyzed.status !== "analyzed" || !analyzed.message.includes("negative")) {
  throw new Error("Expected derived sentiment context.");
}
if (analyzed.message.includes(rawPrivateNote) || JSON.stringify(analyzed).includes(rawPrivateNote)) {
  throw new Error("Raw diary note leaked into coaching context.");
}
fs.rmSync(outDir, { recursive: true, force: true });
console.log("Diary context tests passed.");
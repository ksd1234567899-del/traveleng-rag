import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "./paths.js";

// Shared shape for both tracked pattern categories: grammar mistakes
// (weak_expressions) and vocabulary/phrasing habits (style_patterns). Same
// storage shape, same merge-and-increment logic, same frequency-based
// tiering — see mergePatternUpdates below.
export interface PatternEntry {
  pattern: string;
  count: number;
}

export interface LearnerProfile {
  learner_id: string;
  level: string;
  weak_expressions: PatternEntry[];
  style_patterns: PatternEntry[];
  last_studied_at: string | null;
  last_session_summary: string | null;
}

interface LearnerRow {
  learner_id: string;
  level: string;
  weak_expressions: string;
  style_patterns: string;
  last_studied_at: string | null;
  last_session_summary: string | null;
}

const dbPath = getDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS learners (
    learner_id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    weak_expressions TEXT NOT NULL,
    last_studied_at TEXT,
    last_session_summary TEXT
  )
`);

// The table above pre-dates style_patterns and already has real rows, so a
// fresh column needs an explicit migration — CREATE TABLE IF NOT EXISTS
// alone won't add it to an existing table. Idempotent: ignores the
// "duplicate column" error on every subsequent startup.
function ensureColumn(ddl: string): void {
  try {
    db.exec(`ALTER TABLE learners ADD COLUMN ${ddl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column")) throw error;
  }
}
ensureColumn("style_patterns TEXT NOT NULL DEFAULT '[]'");

// interests/travel_purpose were dropped (stored but never consumed). Existing
// databases already have these NOT NULL columns, so an explicit migration is
// needed — idempotent: ignores the "no such column" error once dropped.
function dropColumnIfExists(column: string): void {
  try {
    db.exec(`ALTER TABLE learners DROP COLUMN ${column}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("no such column")) throw error;
  }
}
dropColumnIfExists("interests");
dropColumnIfExists("travel_purpose");

// Rows written before frequency tracking stored weak_expressions as a plain
// string[]. Normalize those into {pattern, count: 1} on read so old data
// keeps working with no migration script. Reused for style_patterns too —
// same normalization applies regardless of which column it came from.
function normalizePatternEntries(raw: unknown): PatternEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) =>
    typeof entry === "string" ? { pattern: entry, count: 1 } : (entry as PatternEntry),
  );
}

function rowToProfile(row: LearnerRow): LearnerProfile {
  return {
    learner_id: row.learner_id,
    level: row.level,
    weak_expressions: normalizePatternEntries(JSON.parse(row.weak_expressions)),
    style_patterns: normalizePatternEntries(JSON.parse(row.style_patterns)),
    last_studied_at: row.last_studied_at,
    last_session_summary: row.last_session_summary,
  };
}

export function learnerExists(learnerId: string): boolean {
  return db.prepare("SELECT 1 FROM learners WHERE learner_id = ? LIMIT 1").get(learnerId) !== undefined;
}

export function getOrCreateLearner(learnerId: string): LearnerProfile {
  const existing = db
    .prepare("SELECT * FROM learners WHERE learner_id = ?")
    .get(learnerId) as LearnerRow | undefined;

  if (existing) {
    return rowToProfile(existing);
  }

  const defaultProfile: LearnerProfile = {
    learner_id: learnerId,
    level: "B1",
    weak_expressions: [],
    style_patterns: [],
    last_studied_at: null,
    last_session_summary: null,
  };

  db.prepare(
    `INSERT INTO learners (learner_id, level, weak_expressions, style_patterns, last_studied_at, last_session_summary)
     VALUES (@learner_id, @level, @weak_expressions, @style_patterns, @last_studied_at, @last_session_summary)`,
  ).run({
    learner_id: defaultProfile.learner_id,
    level: defaultProfile.level,
    weak_expressions: JSON.stringify(defaultProfile.weak_expressions),
    style_patterns: JSON.stringify(defaultProfile.style_patterns),
    last_studied_at: defaultProfile.last_studied_at,
    last_session_summary: defaultProfile.last_session_summary,
  });

  return defaultProfile;
}

// Pure merge step shared by both pattern categories: exact-text match +
// is_new=false -> increment count; otherwise append as a new entry (with a
// warning if is_new=false claimed a match that isn't actually there — the
// model was supposed to copy existing pattern text verbatim when reusing
// an entry, so this indicates it didn't).
function mergePatternUpdates(
  existing: PatternEntry[],
  updates: { pattern: string; is_new: boolean }[],
): PatternEntry[] {
  const merged = existing.map((entry) => ({ ...entry }));

  for (const update of updates) {
    const pattern = update.pattern.trim();
    if (!pattern) continue;

    if (!update.is_new) {
      const existingEntry = merged.find((entry) => entry.pattern === pattern);
      if (existingEntry) {
        existingEntry.count += 1;
        continue;
      }
      console.warn(
        `mergePatternUpdates: is_new=false but no exact match for "${pattern}" — appending as new instead.`,
      );
    }

    merged.push({ pattern, count: 1 });
  }

  return merged;
}

export function updateLearnerAfterSession(
  learnerId: string,
  sessionSummary: string,
  weakExpressionUpdates: { pattern: string; is_new: boolean }[],
  stylePatternUpdates: { pattern: string; is_new: boolean }[],
): LearnerProfile {
  const profile = getOrCreateLearner(learnerId);

  const mergedWeakExpressions = mergePatternUpdates(profile.weak_expressions, weakExpressionUpdates);
  const mergedStylePatterns = mergePatternUpdates(profile.style_patterns, stylePatternUpdates);

  const lastStudiedAt = new Date().toISOString();

  db.prepare(
    `UPDATE learners
     SET weak_expressions = @weak_expressions,
         style_patterns = @style_patterns,
         last_session_summary = @last_session_summary,
         last_studied_at = @last_studied_at
     WHERE learner_id = @learner_id`,
  ).run({
    learner_id: learnerId,
    weak_expressions: JSON.stringify(mergedWeakExpressions),
    style_patterns: JSON.stringify(mergedStylePatterns),
    last_session_summary: sessionSummary,
    last_studied_at: lastStudiedAt,
  });

  return {
    ...profile,
    weak_expressions: mergedWeakExpressions,
    style_patterns: mergedStylePatterns,
    last_session_summary: sessionSummary,
    last_studied_at: lastStudiedAt,
  };
}

export function updateLearnerLevel(learnerId: string, newLevel: string): LearnerProfile {
  const profile = getOrCreateLearner(learnerId);

  db.prepare(`UPDATE learners SET level = @level WHERE learner_id = @learner_id`).run({
    learner_id: learnerId,
    level: newLevel,
  });

  return { ...profile, level: newLevel };
}

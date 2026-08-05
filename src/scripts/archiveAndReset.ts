// One-off (but reusable) maintenance script: archives existing session logs,
// SQLite learner rows, and vector store documents into a dated folder under
// logs/archive/, then clears the live learners table and vector store so a
// new testing round starts from a clean, empty state. Nothing is deleted
// without first being backed up to logs/archive/<date>/.
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalIndex } from "vectra";
import { getDbPath, getDebugDir, getParticipantsDir, getVectorstoreDir } from "../lib/paths.js";

// Same DATA_DIR-aware locations chat/pretest/server use — so running this
// against a deployment (e.g. `railway run tsx src/scripts/archiveAndReset.ts`)
// archives/clears the actual persistent volume, not an unrelated local copy.
const participantsDir = getParticipantsDir();
const debugDir = getDebugDir();
const logsDir = join(participantsDir, "..");
const dbPath = getDbPath();
const vectorIndexPath = getVectorstoreDir();

const archiveDateFolder = new Date().toISOString().slice(0, 10); // e.g. "2026-07-23"
const archiveDir = join(logsDir, "archive", archiveDateFolder);

// A plain renameSync(src, dest) is enough the first time this runs on a given
// day (dest doesn't exist yet). But running the script more than once on the
// same day — which happens in practice — means dest may already exist from
// the earlier run, and Windows refuses to rename a directory onto an
// existing one (EPERM), unlike a file-onto-file rename (which it allows,
// overwriting). So: try the fast direct rename first; only if that fails
// because dest already exists do we fall back to merging entry-by-entry,
// recursing until we bottom out at individual file renames (which succeed,
// overwriting same-named files from an earlier same-day archive run).
function moveOrMerge(src: string, dest: string): void {
  if (!existsSync(src)) return;

  try {
    renameSync(src, dest);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
  }

  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    moveOrMerge(join(src, entry), join(dest, entry));
  }
  rmdirSync(src);
}

// Whole-directory moves — conversation logs (logs/participants/) and debug
// logs (logs/debug/) are now cleanly separated top-level siblings of
// logs/phase4-test-plan.md, so no per-file exclusion list is needed anymore.
// This also means any future per-session JSON files added inside
// participants/<learnerId>/ get archived automatically with no further
// changes here.
function archiveLogs(): void {
  mkdirSync(archiveDir, { recursive: true }); // needed unconditionally — the backup JSONs below land here regardless

  if (existsSync(participantsDir)) {
    moveOrMerge(participantsDir, join(archiveDir, "participants"));
    console.log(`moved logs/participants -> logs/archive/${archiveDateFolder}/participants`);
  }

  if (existsSync(debugDir)) {
    moveOrMerge(debugDir, join(archiveDir, "debug"));
    console.log(`moved logs/debug -> logs/archive/${archiveDateFolder}/debug`);
  }
}

// Same-day re-runs are routine (this got hit for real during a 15-participant
// study's cleanup workflow) — a plain fixed "<name>-backup.json" path would
// silently overwrite an earlier run's backup with a later, possibly much
// smaller one (e.g. after the table's already been cleared), destroying data
// with no trace it ever happened. Instead: the first backup of the day keeps
// the plain name; every subsequent run on the same day gets "-2", "-3", ...
// appended, so nothing already on disk is ever overwritten.
function uniqueBackupPath(baseName: string): string {
  const primary = join(archiveDir, `${baseName}.json`);
  if (!existsSync(primary)) return primary;

  for (let n = 2; ; n++) {
    const candidate = join(archiveDir, `${baseName}-${n}.json`);
    if (!existsSync(candidate)) return candidate;
  }
}

function archiveAndClearLearners(): void {
  const db = new DatabaseSync(dbPath);

  const rows = db.prepare("SELECT * FROM learners").all();
  const backupPath = uniqueBackupPath("learners-backup");
  writeFileSync(backupPath, JSON.stringify(rows, null, 2), "utf-8");
  console.log(`backed up ${rows.length} learner rows -> logs/archive/${archiveDateFolder}/${basename(backupPath)}`);

  db.exec("DELETE FROM learners");
  const remaining = db.prepare("SELECT COUNT(*) as count FROM learners").get() as { count: number };
  console.log(`learners table now has ${remaining.count} row(s)`);

  db.close();
}

async function archiveAndClearVectorStore(): Promise<void> {
  const index = new LocalIndex(vectorIndexPath);

  if (await index.isIndexCreated()) {
    const items = await index.listItems();
    const backup = items.map((item) => ({
      doc_id: item.metadata.doc_id,
      learner_id: item.metadata.learner_id,
      type: item.metadata.type,
      scenario: item.metadata.scenario,
      date: item.metadata.date,
      text: item.metadata.text,
    }));
    const backupPath = uniqueBackupPath("vectorstore-backup");
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
    console.log(`backed up ${backup.length} vector doc(s) -> logs/archive/${archiveDateFolder}/${basename(backupPath)}`);

    await index.deleteIndex();
  }

  await index.createIndex();
  const stats = await index.getIndexStats();
  console.log(`vector store now has ${stats.items} item(s)`);
}

archiveLogs();
archiveAndClearLearners();
await archiveAndClearVectorStore();

console.log("\nDone. logs/ now contains only the archive/ subfolder; learners table and vector store are empty.");

// Alpha-test reset: wipes participant conversation logs, the learners table,
// and personalization vectors (user_mistake / user_utterance) so a fresh
// alpha cohort starts from an empty state. The seeded scenario_knowledge
// vectors are deliberately left untouched — that's fixture data, not
// participant data.
//
// Unlike archiveAndReset.ts, this does NOT back anything up first — it's for
// wiping throwaway pre-alpha test data, not archiving a completed study
// round. Use archiveAndReset.ts instead if the data being cleared needs to
// be preserved.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalIndex } from "vectra";
import { getDbPath, getParticipantsDir, getVectorstoreDir } from "../lib/paths.js";

const participantsDir = getParticipantsDir();
const dbPath = getDbPath();
const vectorIndexPath = getVectorstoreDir();

// Deletes every entry inside participants/ but keeps the directory itself,
// so paths.ts's assumptions (and any process with it open as a cwd) still hold.
function resetParticipantLogs(): number {
  if (!existsSync(participantsDir)) return 0;

  const entries = readdirSync(participantsDir);
  for (const entry of entries) {
    rmSync(join(participantsDir, entry), { recursive: true, force: true });
  }
  return entries.length;
}

function resetLearnersTable(): number {
  const db = new DatabaseSync(dbPath);
  const before = (db.prepare("SELECT COUNT(*) as count FROM learners").get() as { count: number }).count;
  db.exec("DELETE FROM learners");
  db.close();
  return before;
}

// Deletes only user_mistake / user_utterance vectors via a metadata-filtered
// scan + deleteItems — never touches or recreates the index itself, so
// scenario_knowledge vectors (and everything else about the index) are left
// exactly as they were.
async function resetPersonalizationVectors(): Promise<{ deletedCount: number; scenarioKnowledgeRemaining: number }> {
  const index = new LocalIndex(vectorIndexPath);

  if (!(await index.isIndexCreated())) {
    return { deletedCount: 0, scenarioKnowledgeRemaining: 0 };
  }

  const toDelete = await index.listItemsByMetadata({
    type: { $in: ["user_mistake", "user_utterance"] },
  });
  await index.deleteItems(toDelete.map((item) => item.id));

  const scenarioKnowledgeRemaining = (await index.listItemsByMetadata({ type: "scenario_knowledge" })).length;
  return { deletedCount: toDelete.length, scenarioKnowledgeRemaining };
}

const deletedParticipantEntries = resetParticipantLogs();
const deletedLearnerRows = resetLearnersTable();
const { deletedCount: deletedVectorCount, scenarioKnowledgeRemaining } = await resetPersonalizationVectors();

console.log("Alpha test reset complete:");
console.log(`- participant log entries deleted: ${deletedParticipantEntries} (from ${participantsDir})`);
console.log(`- learner rows deleted: ${deletedLearnerRows} (from ${dbPath})`);
console.log(`- user_mistake/user_utterance vectors deleted: ${deletedVectorCount}`);
console.log(`- scenario_knowledge vectors kept (untouched): ${scenarioKnowledgeRemaining}`);

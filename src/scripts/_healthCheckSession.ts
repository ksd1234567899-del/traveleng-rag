import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatSession } from "../lib/chatSession.js";
import { getParticipantsDir } from "../lib/paths.js";

// One-off diagnostic session run directly against whatever DATA_DIR/keys are
// in the current process env (intended to be invoked via
// `IS_TEST_RUN=true railway ssh "..."` so it's tagged safely and never mixes
// into real study data, even though it exercises the exact same production
// vectorstore/SQLite/volume as real sessions do). NOT part of the app —
// meant to be deleted after this pre-study health check.
//
// HEALTHCHECK_LEARNER_ID lets the same learner be run twice (different
// process invocations) to test cross-session weak_expressions/style_patterns
// count accumulation — run 2 deliberately reuses the same grammar slip
// ("I go" instead of "I'm going") so it should be recognized as a recurring
// pattern (is_new: false, count 1 -> 2) rather than a fresh one.
const learnerId = process.env.HEALTHCHECK_LEARNER_ID ?? `_healthcheck_${Date.now()}`;
const isSecondRun = process.env.HEALTHCHECK_RUN === "2";

async function main() {
  console.log("learnerId:", learnerId);
  console.log("DATA_DIR:", process.env.DATA_DIR ?? "(unset)");
  console.log("IS_TEST_RUN:", process.env.IS_TEST_RUN ?? "(unset)");
  console.log("run:", isSecondRun ? 2 : 1);

  const { session, opening } = await ChatSession.start(learnerId, "airport");
  console.log("\n--- opening ---");
  console.log("mission:", opening.missionBriefing);
  console.log("staff:", opening.staffLine);

  const turnsRun1 = [
    "I go to Tokyo for a business trip.",
    "Window, please.",
    "I have one suitcase, and I would like to request a vegetarian meal if possible, since I have dietary restrictions.",
    "Yes.",
    "I'm also wondering if there's a way to get priority boarding, since I have a connecting flight with a tight layover.",
  ];
  const turnsRun2 = [
    "I go to the check-in counter now.",
    "Aisle seat is fine.",
    "I was actually hoping to get some information about lounge access, since I have a long layover.",
    "Yes, that sounds good, thank you.",
  ];
  const turns = isSecondRun ? turnsRun2 : turnsRun1;

  for (const [i, input] of turns.entries()) {
    const result = await session.sendMessage(input);
    console.log(`\n--- turn ${i + 1} ---`);
    console.log("learner:", input);
    console.log("staff:", result.staffLine);
    console.log("tutorLine:", result.tutorLine);
    console.log("styleNote:", result.styleNote);
    console.log("turnNumber:", result.turnNumber);
    if (result.scenarioComplete) {
      console.log("(scenario auto-completed)");
      break;
    }
  }

  const report = session.ended ? session.report! : await session.end();

  console.log("\n=== FINAL REPORT ===");
  console.log("levelBefore:", report.levelBefore, "-> levelAfter:", report.levelAfter, "| changed:", report.levelChanged);
  console.log("correctionRate:", report.correctionRate.toFixed(2));
  console.log("complexRate:", report.complexRate.toFixed(2));
  console.log("totalNormalTurns:", report.totalNormalTurns, "| totalComplexAttempts:", report.totalComplexAttempts, "| totalComplexEligibleTurns:", report.totalComplexEligibleTurns);
  console.log(
    "corrections:",
    report.corrections.map((c) => ({ turnNumber: c.turnNumber, mistakeType: c.mistakeType, wrong: c.wrong, fixed: c.fixed })),
  );
  console.log("weakExpressions:", JSON.stringify(report.weakExpressions));
  console.log("stylePatterns:", JSON.stringify(report.stylePatterns));
  console.log("todaySummary:", report.todaySummary);
  console.log("nextGoal:", report.nextGoal);
  console.log("level_adjustment via reportText snippet included above; sessionNumber:", report.sessionNumber);

  const baseName = `session-${String(report.sessionNumber).padStart(2, "0")}-${report.scenario}`;
  const jsonPath = join(getParticipantsDir(), learnerId, `${baseName}.json`);
  const persisted = JSON.parse(readFileSync(jsonPath, "utf-8"));
  console.log("\n=== PERSISTED JSON ===");
  console.log("is_test_run:", persisted.is_test_run);
  console.log("level_adjustment_reason:", persisted.level_adjustment_reason);
  console.log("totalComplexEligibleTurns (persisted):", persisted.totalComplexEligibleTurns);
  console.log("weak_expression_updates_this_session:", JSON.stringify(persisted.weak_expression_updates_this_session));

  const mdPath = join(getParticipantsDir(), learnerId, `${baseName}.md`);
  console.log("\n=== PERSISTED .md ===\n");
  console.log(readFileSync(mdPath, "utf-8"));

  console.log("\nlearnerId for cleanup:", learnerId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

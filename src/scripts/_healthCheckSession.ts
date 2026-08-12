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
const learnerId = `_healthcheck_${Date.now()}`;

async function main() {
  console.log("learnerId:", learnerId);
  console.log("DATA_DIR:", process.env.DATA_DIR ?? "(unset)");
  console.log("IS_TEST_RUN:", process.env.IS_TEST_RUN ?? "(unset)");

  const { session, opening } = await ChatSession.start(learnerId, "airport");
  console.log("\n--- opening ---");
  console.log("mission:", opening.missionBriefing);
  console.log("staff:", opening.staffLine);

  const turns = [
    "Sure, here's my pasport and booking reference.",
    "I have one suitcase, and I'm actually traveling with my elderly father who needs wheelchair assistance, so I wanted to check if that's something you can arrange here.",
    "Window, please.",
    "Yes, exactly — he has difficulty walking long distances, so wheelchair assistance from the gate would be really helpful.",
    "Also, I was wondering if there's any way to get a meal that's vegetarian, since I don't eat meat.",
    "Yes, that works perfectly, thank you so much!",
  ];

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
  console.log("todaySummary:", report.todaySummary);
  console.log("nextGoal:", report.nextGoal);
  console.log("sessionSummary:", report.sessionSummary);

  const jsonPath = join(getParticipantsDir(), learnerId, "session-01-airport.json");
  const persisted = JSON.parse(readFileSync(jsonPath, "utf-8"));
  console.log("\n=== PERSISTED JSON is_test_run ===", persisted.is_test_run);

  const mdPath = join(getParticipantsDir(), learnerId, "session-01-airport.md");
  console.log("\n=== PERSISTED .md ===\n");
  console.log(readFileSync(mdPath, "utf-8"));

  console.log("\nlearnerId for cleanup:", learnerId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { ChatSession, type SessionReportPayload } from "../lib/chatSession.js";
import { getOrCreateLearner, learnerExists } from "../lib/memory.js";
import { runPretest } from "./pretest.js";

function printStaffLine(text: string): void {
  console.log(chalk.cyan(`Staff: ${text}`) + "\n");
}

function printTutorLine(text: string): void {
  console.log(chalk.magenta(`[튜터]: ${text}`) + "\n");
}

function printStyleNote(text: string): void {
  console.log(chalk.magenta(`[튜터 - 스타일]: ${text}`) + "\n");
}

function printSituationNote(text: string): void {
  console.log(chalk.magenta(`[튜터 - 상황]: ${text}`) + "\n");
}

function printMissionLine(text: string): void {
  console.log(chalk.green(`[미션]: ${text}`) + "\n");
}

function printSessionReport(report: SessionReportPayload): void {
  console.log(chalk.blue(report.reportText) + "\n");
}

function parseArgs(): { learnerId: string; scenarioId: string } {
  const params: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (match) params[match[1]] = match[2];
  }
  return { learnerId: params.learner ?? "user_001", scenarioId: params.scenario ?? "airport" };
}

const { learnerId: LEARNER_ID, scenarioId } = parseArgs();
const rl = createInterface({ input: process.stdin, output: process.stdout });

if (!learnerExists(LEARNER_ID)) {
  await runPretest(LEARNER_ID, rl);
  console.log(
    `\n첫 세션의 프리테스트가 완료되었습니다. 실제 시나리오를 시작하려면 다시 실행해주세요 (예: --scenario=${scenarioId}).`,
  );
  rl.close();
  process.exit(0);
}

const preSessionProfile = getOrCreateLearner(LEARNER_ID);
console.log(`Loaded profile for ${preSessionProfile.learner_id} (level ${preSessionProfile.level})`);

const { session, opening } = await ChatSession.start(LEARNER_ID, scenarioId);

console.log(`--- Roleplay: ${session.scenario.title} ---`);
console.log('Type your messages below. Type "exit" or "quit" to end.\n');
printMissionLine(opening.missionBriefing);
printStaffLine(opening.staffLine);

let finalReport: SessionReportPayload | null = null;

while (!session.ended) {
  let userInput: string;
  try {
    userInput = await rl.question(chalk.yellow("You: "));
  } catch {
    // stdin closed (e.g. piped input ended, or Ctrl+D) — treat like exit
    break;
  }
  if (["exit", "quit"].includes(userInput.trim().toLowerCase())) {
    break;
  }

  const result = await session.sendMessage(userInput);
  if (result.tutorLine) printTutorLine(result.tutorLine);
  if (result.staffLine) printStaffLine(result.staffLine);
  if (result.situationNote) printSituationNote(result.situationNote);
  if (result.styleNote) printStyleNote(result.styleNote);
  if (result.report) finalReport = result.report;
}

if (!session.ended) {
  finalReport = await session.end();
}

rl.close();

if (finalReport) {
  printSessionReport(finalReport);

  const updatedProfile = getOrCreateLearner(LEARNER_ID);
  console.log("--- Updated Learner Profile ---");
  console.log(JSON.stringify(updatedProfile, null, 2));
}

console.log("Conversation ended.");

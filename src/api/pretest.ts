import type { Interface } from "node:readline/promises";
import chalk from "chalk";
import { PretestSession, PRETEST_MAX_LEARNER_TURNS, type PretestReportPayload } from "../lib/pretestSession.js";
import { MIN_TURNS_FOR_LEVEL_ADJUSTMENT } from "../lib/levelAdjustment.js";

function printPartnerLine(text: string): void {
  console.log(chalk.cyan(`Partner: ${text}`) + "\n");
}

function printReport(report: PretestReportPayload): void {
  console.log(
    chalk.blue(
      `초기 레벨: ${report.startingLevel} (correctionRate ${report.correctionRate.toFixed(2)}, complexRate ${report.complexRate.toFixed(2)})`,
    ),
  );

  if (!report.validMeasurement) {
    console.log(
      chalk.yellow(
        `⚠️ 사전 테스트가 완료되지 않았습니다 (${report.totalNormalTurns}턴만 진행, 최소 ${MIN_TURNS_FOR_LEVEL_ADJUSTMENT}턴 필요) — 기본값 B1이 그대로 사용되었습니다.`,
      ),
    );
  }
  if (report.totalDetectionFailures > 0) {
    console.log(
      chalk.yellow(
        `⚠️ ${report.totalDetectionFailures}개 턴에서 채점이 일시적으로 실패해 정확히 평가되지 못했을 수 있습니다 — 위 결과가 실제와 다를 수 있습니다.`,
      ),
    );
  }
}

// CLI driver for PretestSession — all scoring/classification logic lives in
// the session class now (also used by the HTTP server); this function is
// just readline plumbing plus the same console output the original inline
// implementation printed.
export async function runPretest(learnerId: string, rl: Interface): Promise<void> {
  const scenarioTitle = "Getting to Know You";
  console.log(`--- Pretest: ${scenarioTitle} ---`);
  console.log('Type your messages below. Type "exit" or "quit" to end early.\n');

  const { session, opening } = await PretestSession.start(learnerId);
  printPartnerLine(opening.partnerLine);

  for (let turnIndex = 1; turnIndex <= PRETEST_MAX_LEARNER_TURNS; turnIndex++) {
    let userInput: string;
    try {
      userInput = await rl.question(chalk.yellow("You: "));
    } catch {
      break;
    }
    if (["exit", "quit"].includes(userInput.trim().toLowerCase())) {
      break;
    }

    const result = await session.sendMessage(userInput);
    printPartnerLine(result.partnerLine);
  }

  const report = session.ended ? session.report! : await session.end();
  printReport(report);
}

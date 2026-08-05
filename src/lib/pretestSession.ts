import Anthropic from "@anthropic-ai/sdk";
import {
  buildIssueDetectionInstruction,
  buildIssueDetectionSystemPrompt,
  buildPretestOpeningInstruction,
  buildPretestReplyInstruction,
  buildPretestSystemPrompt,
  type Scenario,
} from "./prompts.js";
import { getOrCreateLearner, updateLearnerLevel } from "./memory.js";
import { writeSessionLog, writeSessionData, type SessionTurn } from "./sessionLog.js";
import { requestWithRetry, withReformatNudge } from "./apiRetry.js";
import { computeLevelAdjustment, MIN_TURNS_FOR_LEVEL_ADJUSTMENT } from "./levelAdjustment.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The starting-point level the pretest's one-shot classification is seeded
// from. Not a guess about the learner — computeLevelAdjustment can only move
// one tier per call, so seeding at the middle tier lets a single pretest
// conversation land on any of A2/B1/B2 depending on how it goes.
const SEED_LEVEL = "B1";

// A fixed number of learner turns, not an LLM-judged "scenario_complete" —
// there's no task to finish, so the conversation just needs a deterministic
// length. Comfortably above MIN_TURNS_FOR_LEVEL_ADJUSTMENT so a full run
// always produces a usable classification.
export const PRETEST_MAX_LEARNER_TURNS = 7;

const PRETEST_SESSION_START_MARKER = "[PRETEST START — internal trigger, not learner input]";

function contentToText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join(" ");
}

function loadPretestScenario(): Scenario {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scenarioPath = join(__dirname, "..", "data", "scenarios", "pretest.json");
  if (!existsSync(scenarioPath)) {
    throw new Error(`Pretest scenario file missing at ${scenarioPath}`);
  }
  return JSON.parse(readFileSync(scenarioPath, "utf-8"));
}

interface PretestLineResponse {
  partner_line: string;
}

interface IssueDetectionResponse {
  has_issue: boolean;
  attempted_complex_phrasing: boolean;
}

export interface PretestOpeningResult {
  partnerLine: string;
}

export interface PretestReportPayload {
  learnerId: string;
  startingLevel: string;
  correctionRate: number;
  complexRate: number;
  totalNormalTurns: number;
  totalDetectionFailures: number;
  validMeasurement: boolean;
}

export interface PretestTurnResult {
  partnerLine: string;
  pretestComplete: boolean;
  report: PretestReportPayload | null;
}

// One-time, first-ever-session calibration probe: casual small talk (no
// mission, no visible corrections, no tutor voice) that silently scores the
// learner via the same issue-detection call the real scenarios use, then
// classifies a starting level via computeLevelAdjustment seeded at
// SEED_LEVEL — replacing the B1 default with an actual measurement before
// the learner's real scenario work begins.
//
// Holds all per-conversation state as instance fields (rather than the
// module-scope variables the original CLI script used) so multiple pretest
// conversations can run concurrently in one process — one instance per
// learner session, driven either by the CLI's readline loop or by the HTTP
// server's /session/message endpoint. The turn-by-turn logic itself (prompts,
// retry behavior, scoring, level classification) is unchanged from the
// original CLI implementation.
export class PretestSession {
  readonly learnerId: string;
  private readonly client: Anthropic;
  private readonly systemPrompt: string;
  private readonly issueDetectionSystemPrompt: string;
  private readonly messages: Anthropic.MessageParam[] = [];

  private turnCount = 0;
  private correctionCount = 0;
  private complexAttemptCount = 0;
  private detectionFailureCount = 0;

  ended = false;
  report: PretestReportPayload | null = null;

  private constructor(learnerId: string) {
    this.learnerId = learnerId;
    const scenario = loadPretestScenario();
    this.client = new Anthropic();
    this.systemPrompt = buildPretestSystemPrompt(scenario);
    this.issueDetectionSystemPrompt = buildIssueDetectionSystemPrompt(scenario, SEED_LEVEL);
  }

  static async start(learnerId: string): Promise<{ session: PretestSession; opening: PretestOpeningResult }> {
    // Guarantees a row exists immediately, before any API call can fail — so
    // even a hard crash mid-pretest leaves the learner with a valid B1 row,
    // and the next invocation's learnerExists check correctly skips the
    // pretest rather than looping the learner back into it forever.
    getOrCreateLearner(learnerId);

    const session = new PretestSession(learnerId);
    session.messages.push({ role: "user", content: PRETEST_SESSION_START_MARKER });

    const opening = await session.requestPretestLine(
      session.systemPrompt + "\n\n" + buildPretestOpeningInstruction(),
      session.messages,
    );
    session.messages.push({ role: "assistant", content: opening.partner_line });

    return { session, opening: { partnerLine: opening.partner_line } };
  }

  // Learner's next turn. Auto-completes (writes pretest.json/.md, computes
  // starting level) once PRETEST_MAX_LEARNER_TURNS learner turns have been
  // processed — mirrors the CLI's fixed-length loop exactly.
  async sendMessage(userInput: string): Promise<PretestTurnResult> {
    if (this.ended) {
      throw new Error("Pretest session has already ended");
    }

    this.messages.push({ role: "user", content: userInput });
    this.turnCount += 1;

    const detection = await this.requestPretestIssueDetection();
    if (detection.has_issue) this.correctionCount += 1;
    if (detection.attempted_complex_phrasing) this.complexAttemptCount += 1;

    const isLastTurn = this.turnCount >= PRETEST_MAX_LEARNER_TURNS;
    const reply = await this.requestPretestLine(
      this.systemPrompt + "\n\n" + buildPretestReplyInstruction(isLastTurn),
      this.messages,
    );
    this.messages.push({ role: "assistant", content: reply.partner_line });

    if (isLastTurn) {
      const report = this.finalize();
      return { partnerLine: reply.partner_line, pretestComplete: true, report };
    }

    return { partnerLine: reply.partner_line, pretestComplete: false, report: null };
  }

  // Manual early end (equivalent to the CLI's "exit"/"quit"). Below
  // MIN_TURNS_FOR_LEVEL_ADJUSTMENT, computeLevelAdjustment leaves the level
  // at SEED_LEVEL, same as the original CLI behavior.
  async end(): Promise<PretestReportPayload> {
    if (this.ended) {
      if (!this.report) throw new Error("Pretest session ended without a report");
      return this.report;
    }
    return this.finalize();
  }

  private finalize(): PretestReportPayload {
    this.ended = true;

    const turns: SessionTurn[] = this.messages.slice(1).map((m) => ({
      role: m.role as "user" | "assistant",
      text: contentToText(m.content),
    }));
    const sessionLogResult = writeSessionLog({ learnerId: this.learnerId, scenarioId: "pretest", turns });

    const levelAdjustment = computeLevelAdjustment(
      SEED_LEVEL,
      this.correctionCount,
      this.turnCount,
      this.complexAttemptCount,
    );
    updateLearnerLevel(this.learnerId, levelAdjustment.newLevel);

    const rate = this.turnCount > 0 ? this.correctionCount / this.turnCount : 0;
    const complexRate = this.turnCount > 0 ? this.complexAttemptCount / this.turnCount : 0;
    const validMeasurement = this.turnCount >= MIN_TURNS_FOR_LEVEL_ADJUSTMENT;

    if (sessionLogResult) {
      writeSessionData(this.learnerId, sessionLogResult.baseName, {
        learner_id: this.learnerId,
        timestamp: new Date().toISOString(),
        correctionRate: rate,
        complexRate,
        starting_level: levelAdjustment.newLevel,
        totalNormalTurns: this.turnCount,
        totalDetectionFailures: this.detectionFailureCount,
        valid_measurement: validMeasurement,
      });
    }

    this.report = {
      learnerId: this.learnerId,
      startingLevel: levelAdjustment.newLevel,
      correctionRate: rate,
      complexRate,
      totalNormalTurns: this.turnCount,
      totalDetectionFailures: this.detectionFailureCount,
      validMeasurement,
    };
    return this.report;
  }

  private async requestPretestLineOnce(
    turnSystemPrompt: string,
    callMessages: Anthropic.MessageParam[],
  ): Promise<PretestLineResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: turnSystemPrompt,
      messages: callMessages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in pretest-line response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as Partial<PretestLineResponse>;
    if (typeof parsed.partner_line !== "string") {
      throw new Error("Pretest-line response missing partner_line");
    }

    return { partner_line: parsed.partner_line };
  }

  private async requestPretestLine(
    turnSystemPrompt: string,
    messages: Anthropic.MessageParam[],
  ): Promise<PretestLineResponse> {
    return requestWithRetry(
      "Pretest-line",
      (includeReformatNudge) =>
        this.requestPretestLineOnce(turnSystemPrompt, includeReformatNudge ? withReformatNudge(messages) : messages),
      () => ({ partner_line: "Sorry, could you say that again?" }),
    );
  }

  private async requestPretestIssueDetectionOnce(
    turnSystemPrompt: string,
    callMessages: Anthropic.MessageParam[],
  ): Promise<IssueDetectionResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: turnSystemPrompt,
      messages: callMessages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in issue-detection response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as { has_issue?: unknown; attempted_complex_phrasing?: unknown };

    return {
      has_issue: parsed.has_issue === true,
      attempted_complex_phrasing: parsed.attempted_complex_phrasing === true,
    };
  }

  private async requestPretestIssueDetection(): Promise<IssueDetectionResponse> {
    const turnSystemPrompt = this.issueDetectionSystemPrompt + "\n\n" + buildIssueDetectionInstruction();
    return requestWithRetry(
      "Pretest issue-detection",
      (includeReformatNudge) =>
        this.requestPretestIssueDetectionOnce(
          turnSystemPrompt,
          includeReformatNudge ? withReformatNudge(this.messages) : this.messages,
        ),
      () => {
        this.detectionFailureCount += 1;
        return { has_issue: false, attempted_complex_phrasing: false };
      },
    );
  }
}

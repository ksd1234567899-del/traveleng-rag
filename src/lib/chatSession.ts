import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildIssueDetectionInstruction,
  buildIssueDetectionSystemPrompt,
  buildMemorySummaryPrompt,
  buildMissionChecklistBlock,
  buildOpeningInstruction,
  buildRepeatTurnInstruction,
  buildRetrievedContextBlock,
  buildSessionReportPrompt,
  buildStaffDialogueInstruction,
  buildSystemPrompt,
  pickMissionElements,
  type MissionChecklistItem,
  type Scenario,
} from "./prompts.js";
import {
  getOrCreateLearner,
  updateLearnerAfterSession,
  updateLearnerLevel,
  type LearnerProfile,
  type PatternEntry,
} from "./memory.js";
import { retrieveContext } from "./retrieval.js";
import { addDocument } from "./vectorstore.js";
import { writeSessionLog, writeSessionData, type SessionTurn } from "./sessionLog.js";
import { debugLog } from "./debugLog.js";
import { REFORMAT_NUDGE, requestWithRetry, withReformatNudge } from "./apiRetry.js";
import { computeLevelAdjustment } from "./levelAdjustment.js";

// Hidden synthetic first turn — the API requires messages[0] to be role
// "user", so this triggers the AI-led opening while staying invisible to
// the learner and excluded from logs/summaries (see getLoggableMessages).
const SESSION_START_MARKER = "[SESSION START — internal trigger, not learner input]";

function contentToText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join(" ");
}

function loadScenario(scenarioId: string): Scenario {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scenarioPath = join(__dirname, "..", "data", "scenarios", `${scenarioId}.json`);
  if (!existsSync(scenarioPath)) {
    throw new Error(`Unknown scenario "${scenarioId}" — no file at ${scenarioPath}`);
  }
  return JSON.parse(readFileSync(scenarioPath, "utf-8"));
}

interface MemorySummary {
  session_summary: string;
  weak_expression_updates: { pattern: string; is_new: boolean }[];
  style_pattern_updates: { pattern: string; is_new: boolean }[];
}

interface IssueDetectionResponse {
  has_issue: boolean;
  tutor_line: string | null;
  original_phrase: string | null;
  corrected_phrase: string | null;
  checklist_updates: string[];
  attempted_complex_phrasing: boolean;
  style_pattern_note: string | null;
}

interface StaffDialogueResponse {
  staff_line: string;
  scenario_complete: boolean;
}

interface RepeatTurnResponse {
  staff_line: string;
  tutor_line: string;
  scenario_complete: boolean;
}

interface OpeningResponse {
  mission_briefing: string;
  staff_line: string;
  mission_checklist: MissionChecklistItem[];
}

interface SessionReportResponse {
  checklist_notes: { id: string; note_ko: string }[];
  focus_suggestions: string[];
}

export interface OpeningResult {
  missionBriefing: string;
  staffLine: string;
  missionChecklist: MissionChecklistItem[];
}

export interface MessageTurnResult {
  staffLine: string | null;
  tutorLine: string | null;
  styleNote: string | null;
  scenarioComplete: boolean;
  awaitingRepeat: boolean;
  missionChecklist: MissionChecklistItem[];
  // Set only when this turn triggered auto-finalize (scenarioComplete: true).
  report: SessionReportPayload | null;
}

export interface SessionReportPayload {
  learnerId: string;
  scenario: string;
  sessionNumber: number | null;
  sessionEndType: "auto" | "manual_exit";
  levelBefore: string;
  levelAfter: string;
  levelChanged: boolean;
  correctionRate: number;
  complexRate: number;
  totalNormalTurns: number;
  totalCorrections: number;
  totalComplexAttempts: number;
  totalDetectionFailures: number;
  missionChecklist: MissionChecklistItem[];
  corrections: { wrong: string; fixed: string }[];
  checklistNotes: { id: string; note_ko: string }[];
  focusSuggestions: string[];
  reportText: string;
  weakExpressions: PatternEntry[];
  stylePatterns: PatternEntry[];
  sessionSummary: string;
}

// Holds one learner's roleplay session as instance state (rather than the
// module-scope variables the original CLI script used), so multiple
// scenario sessions can run concurrently in one process — one instance per
// active session, driven either by the CLI's readline loop or by the HTTP
// server's /session/message endpoint. All prompts, API-call sequencing,
// retry/fallback behavior, checklist tracking, and level-adjustment math are
// unchanged from the original CLI implementation.
export class ChatSession {
  readonly learnerId: string;
  readonly scenario: Scenario;
  private readonly client: Anthropic;
  private readonly systemPrompt: string;
  private readonly issueDetectionSystemPrompt: string;
  private readonly learnerProfile: LearnerProfile;
  private readonly messages: Anthropic.MessageParam[] = [];

  private readonly missionChecklist: MissionChecklistItem[] = [];
  private readonly sessionCorrections: { wrong: string; fixed: string }[] = [];
  private totalNormalTurns = 0;
  private totalComplexAttempts = 0;
  private styleNoteShownThisSession = false;
  private totalDetectionFailures = 0;
  private awaitingRepeat = false;

  ended = false;
  report: SessionReportPayload | null = null;

  private constructor(learnerId: string, scenarioId: string, learnerProfile: LearnerProfile) {
    this.learnerId = learnerId;
    this.scenario = loadScenario(scenarioId);
    this.learnerProfile = learnerProfile;
    this.client = new Anthropic();
    this.systemPrompt = buildSystemPrompt(this.scenario, learnerProfile.level);
    this.issueDetectionSystemPrompt = buildIssueDetectionSystemPrompt(this.scenario, learnerProfile.level);
  }

  static async start(learnerId: string, scenarioId: string): Promise<{ session: ChatSession; opening: OpeningResult }> {
    const learnerProfile = getOrCreateLearner(learnerId);
    const session = new ChatSession(learnerId, scenarioId, learnerProfile);
    const opening = await session.runOpeningTurn();
    return { session, opening };
  }

  private async runOpeningTurn(): Promise<OpeningResult> {
    this.messages.push({ role: "user", content: SESSION_START_MARKER });

    const retrieved = await retrieveContext({
      learnerId: this.learnerId,
      scenario: this.scenario.id,
      userMessage: this.scenario.description,
    });

    const missionElements = pickMissionElements(this.learnerProfile.level, this.scenario.missionElementPool);
    const turnSystemPrompt =
      this.systemPrompt +
      "\n\n" +
      buildRetrievedContextBlock(retrieved) +
      "\n\n" +
      buildOpeningInstruction(this.learnerProfile.level, missionElements, this.scenario.missionBasics);

    debugLog(
      this.learnerId,
      `\n[chat debug] --- final system prompt sent to Claude (learner_id=${this.learnerId}) ---\n${turnSystemPrompt}\n[chat debug] --- end system prompt ---\n`,
    );
    debugLog(
      this.learnerId,
      `[chat debug] level=${this.learnerProfile.level}, mission_elements=${JSON.stringify(missionElements)}, top weak_expression=${retrieved.mistakes[0]?.text ?? "(none)"}`,
    );

    const parsed = await this.requestOpeningResponse(turnSystemPrompt);
    this.missionChecklist.push(...parsed.mission_checklist);

    const displayText = `${parsed.mission_briefing}\n\n${parsed.staff_line}`;
    this.messages.push({ role: "assistant", content: displayText });

    return {
      missionBriefing: parsed.mission_briefing,
      staffLine: parsed.staff_line,
      missionChecklist: this.missionChecklist,
    };
  }

  // `mode` drives the tutor-voice state machine: "normal" = real roleplay
  // input, evaluated by a narrow issue-detection call before Staff ever gets
  // a turn to speak; "repeat" = the learner's message is their attempt to
  // repeat back a correction, tutor briefly acknowledges and Staff continues
  // (single combined call, unchanged).
  async sendMessage(userInput: string): Promise<MessageTurnResult> {
    if (this.ended) {
      throw new Error("Chat session has already ended");
    }

    this.messages.push({ role: "user", content: userInput });

    const retrieved = await retrieveContext({
      learnerId: this.learnerId,
      scenario: this.scenario.id,
      userMessage: userInput,
    });
    const retrievedContextBlock = buildRetrievedContextBlock(retrieved);
    const checklistBlock = buildMissionChecklistBlock(this.missionChecklist);

    if (this.awaitingRepeat) {
      const turnSystemPrompt =
        this.systemPrompt + "\n\n" + retrievedContextBlock + "\n\n" + buildRepeatTurnInstruction(this.scenario.completionExample);

      debugLog(
        this.learnerId,
        `\n[chat debug] --- final system prompt sent to Claude (learner_id=${this.learnerId}, call=repeat) ---\n${turnSystemPrompt}\n[chat debug] --- end system prompt ---\n`,
      );

      const parsed = await this.requestRepeatTurn(turnSystemPrompt);
      this.messages.push({ role: "assistant", content: `[튜터]: ${parsed.tutor_line}\n\n${parsed.staff_line}` });
      this.awaitingRepeat = false;

      return this.finishTurn({
        staffLine: parsed.staff_line,
        tutorLine: parsed.tutor_line,
        styleNote: null,
        scenarioComplete: parsed.scenario_complete,
        awaitingRepeat: false,
        missionChecklist: this.missionChecklist,
        report: null,
      });
    }

    // Call A (issue detection) always runs first; Call B (staff dialogue)
    // only runs if Call A found nothing worth flagging. Neither call's
    // prompt ever asks the model to do the other's job.
    this.totalNormalTurns += 1;
    const detectionSystemPrompt =
      this.issueDetectionSystemPrompt + "\n\n" + retrievedContextBlock + "\n\n" + checklistBlock + "\n\n" + buildIssueDetectionInstruction();

    debugLog(
      this.learnerId,
      `\n[chat debug] --- final system prompt sent to Claude (learner_id=${this.learnerId}, call=detection) ---\n${detectionSystemPrompt}\n[chat debug] --- end system prompt ---\n`,
    );

    const detection = await this.requestIssueDetection(detectionSystemPrompt);
    this.applyChecklistUpdates(detection.checklist_updates);
    if (detection.attempted_complex_phrasing) this.totalComplexAttempts += 1;

    if (detection.has_issue) {
      this.sessionCorrections.push({
        wrong: detection.original_phrase as string,
        fixed: detection.corrected_phrase as string,
      });
      this.messages.push({ role: "assistant", content: `[튜터]: ${detection.tutor_line}` });
      this.awaitingRepeat = true;

      return this.finishTurn({
        staffLine: null,
        tutorLine: detection.tutor_line,
        styleNote: null,
        scenarioComplete: false,
        awaitingRepeat: true,
        missionChecklist: this.missionChecklist,
        report: null,
      });
    }

    const staffSystemPrompt =
      this.systemPrompt + "\n\n" + retrievedContextBlock + "\n\n" + checklistBlock + "\n\n" + buildStaffDialogueInstruction(this.scenario.completionExample);

    debugLog(
      this.learnerId,
      `\n[chat debug] --- final system prompt sent to Claude (learner_id=${this.learnerId}, call=staff) ---\n${staffSystemPrompt}\n[chat debug] --- end system prompt ---\n`,
    );
    debugLog(
      this.learnerId,
      `[chat debug] level=${this.learnerProfile.level}, top weak_expression=${retrieved.mistakes[0]?.text ?? "(none)"}`,
    );

    const staffResp = await this.requestStaffDialogue(staffSystemPrompt);
    this.messages.push({ role: "assistant", content: staffResp.staff_line });

    // Only reachable when !detection.has_issue — this IS the code-side
    // suppression: a style note never coexists with a grammar correction in
    // the same turn. Capped at once per session.
    let styleNote: string | null = null;
    if (detection.style_pattern_note && !this.styleNoteShownThisSession) {
      this.styleNoteShownThisSession = true;
      styleNote = detection.style_pattern_note;
    }

    return this.finishTurn({
      staffLine: staffResp.staff_line,
      tutorLine: null,
      styleNote,
      scenarioComplete: staffResp.scenario_complete,
      awaitingRepeat: false,
      missionChecklist: this.missionChecklist,
      report: null,
    });
  }

  // Auto-finalizes (session log + memory summary + level adjustment +
  // report) the instant scenario_complete comes back true — mirrors the
  // CLI's while-loop exit, just triggered from within the turn instead of a
  // separate readline iteration.
  private async finishTurn(result: MessageTurnResult): Promise<MessageTurnResult> {
    if (!result.scenarioComplete) return result;
    const report = await this.finalize("auto");
    return { ...result, report };
  }

  // Manual end (equivalent to the CLI's "exit"/"quit").
  async end(): Promise<SessionReportPayload> {
    if (this.ended) {
      if (!this.report) throw new Error("Chat session ended without a report");
      return this.report;
    }
    return this.finalize("manual_exit");
  }

  private getLoggableMessages(): Anthropic.MessageParam[] {
    return this.messages.slice(1);
  }

  private async finalize(sessionEndType: "auto" | "manual_exit"): Promise<SessionReportPayload> {
    this.ended = true;

    const loggable = this.getLoggableMessages();
    const turns: SessionTurn[] = loggable.map((m) => ({
      role: m.role as "user" | "assistant",
      text: contentToText(m.content),
    }));
    const sessionLogResult = writeSessionLog({ learnerId: this.learnerId, scenarioId: this.scenario.id, turns });

    const reportResponse = await this.requestSessionReport();
    const reportText = this.buildSessionReportText(reportResponse);

    const transcript = loggable
      .map((m) => `${m.role === "user" ? "Learner" : "Staff"}: ${contentToText(m.content)}`)
      .join("\n");

    let sessionSummary = "Automatic summary generation failed for this session — see the session log for the full transcript.";
    let weakExpressions = this.learnerProfile.weak_expressions;
    let stylePatterns = this.learnerProfile.style_patterns;
    let levelAdjustment = { newLevel: this.learnerProfile.level, reason: "no conversation to save" };

    if (loggable.length > 0) {
      try {
        const parsed = await this.requestMemorySummary(transcript);
        sessionSummary = parsed?.session_summary ?? sessionSummary;
        const weakExpressionUpdates = Array.isArray(parsed?.weak_expression_updates) ? parsed.weak_expression_updates : [];
        const stylePatternUpdates = Array.isArray(parsed?.style_pattern_updates) ? parsed.style_pattern_updates : [];

        const updatedProfile = updateLearnerAfterSession(this.learnerId, sessionSummary, weakExpressionUpdates, stylePatternUpdates);
        weakExpressions = updatedProfile.weak_expressions;
        stylePatterns = updatedProfile.style_patterns;

        const newPatterns = weakExpressionUpdates.filter((u) => u.is_new).map((u) => u.pattern);
        await this.saveSessionVectorDocs(newPatterns);

        // Computed from THIS session's starting level (the profile snapshot
        // loaded at session start) — updateLearnerAfterSession above never
        // touches level, so this picks up both the just-written
        // weak_expressions and the new level together.
        levelAdjustment = computeLevelAdjustment(
          this.learnerProfile.level,
          this.sessionCorrections.length,
          this.totalNormalTurns,
          this.totalComplexAttempts,
        );
        debugLog(this.learnerId, `[chat debug] level adjustment: ${levelAdjustment.reason}`);
        if (levelAdjustment.newLevel !== this.learnerProfile.level) {
          updateLearnerLevel(this.learnerId, levelAdjustment.newLevel);
        }
      } catch (error) {
        console.error("Failed to save session memory:", error);
      }
    }

    const correctionRate = this.totalNormalTurns > 0 ? this.sessionCorrections.length / this.totalNormalTurns : 0;
    const complexRate = this.totalNormalTurns > 0 ? this.totalComplexAttempts / this.totalNormalTurns : 0;

    if (sessionLogResult) {
      writeSessionData(this.learnerId, sessionLogResult.baseName, {
        learner_id: this.learnerId,
        scenario: this.scenario.id,
        session_number: sessionLogResult.sessionNumber,
        timestamp: new Date().toISOString(),
        level_before: this.learnerProfile.level,
        level_after: levelAdjustment.newLevel,
        level_changed: levelAdjustment.newLevel !== this.learnerProfile.level,
        correctionRate,
        complexRate,
        level_adjustment_reason: levelAdjustment.reason,
        totalNormalTurns: this.totalNormalTurns,
        totalCorrections: this.sessionCorrections.length,
        totalComplexAttempts: this.totalComplexAttempts,
        weak_expressions: weakExpressions,
        style_patterns: stylePatterns,
        mission_checklist: this.missionChecklist,
        totalDetectionFailures: this.totalDetectionFailures,
        session_end_type: sessionEndType,
      });
    }

    this.report = {
      learnerId: this.learnerId,
      scenario: this.scenario.id,
      sessionNumber: sessionLogResult?.sessionNumber ?? null,
      sessionEndType,
      levelBefore: this.learnerProfile.level,
      levelAfter: levelAdjustment.newLevel,
      levelChanged: levelAdjustment.newLevel !== this.learnerProfile.level,
      correctionRate,
      complexRate,
      totalNormalTurns: this.totalNormalTurns,
      totalCorrections: this.sessionCorrections.length,
      totalComplexAttempts: this.totalComplexAttempts,
      totalDetectionFailures: this.totalDetectionFailures,
      missionChecklist: this.missionChecklist,
      corrections: this.sessionCorrections,
      checklistNotes: reportResponse?.checklist_notes ?? [],
      focusSuggestions: reportResponse?.focus_suggestions ?? [],
      reportText,
      weakExpressions,
      stylePatterns,
      sessionSummary,
    };
    return this.report;
  }

  private async saveSessionVectorDocs(newWeakExpressions: string[]): Promise<void> {
    try {
      const now = new Date().toISOString();

      for (const [i, expression] of newWeakExpressions.entries()) {
        await addDocument({
          id: `mistake_${this.learnerId}_${Date.now()}_${i}`,
          text: expression,
          metadata: { type: "user_mistake", learner_id: this.learnerId, scenario: this.scenario.id, date: now },
        });
      }

      const userMessages = this.getLoggableMessages().filter((m) => m.role === "user");
      for (const [i, m] of userMessages.entries()) {
        const text = contentToText(m.content);
        if (!text.trim()) continue;
        await addDocument({
          id: `utterance_${this.learnerId}_${Date.now()}_${i}`,
          text,
          metadata: { type: "user_utterance", learner_id: this.learnerId, scenario: this.scenario.id },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to save session vector documents, continuing: ${message}`);
    }
  }

  private applyChecklistUpdates(ids: string[]): void {
    for (const id of ids) {
      const item = this.missionChecklist.find((entry) => entry.id === id);
      if (item) item.done = true;
    }
  }

  // Assembles the same printed report text the CLI used to show. Which
  // items are ✅/❌ and what the actual corrections were is entirely
  // code-tracked (missionChecklist/sessionCorrections) — the model only
  // supplies the natural-language notes for skipped items and the focus
  // suggestions, never the pass/fail judgment itself.
  private buildSessionReportText(reportResponse: SessionReportResponse | null): string {
    const lines: string[] = [];
    const divider = "──────────────────────";

    lines.push("📋 오늘의 세션 리포트", divider);

    if (this.missionChecklist.length > 0) {
      lines.push("", "[미션 체크리스트]");
      if (this.totalDetectionFailures > 0) {
        lines.push(
          `⚠️ 이번 세션 중 일부 턴(${this.totalDetectionFailures}개)에서 일시적 오류로 정확히 확인하지 못했을 수 있어요 — 아래 결과가 실제와 다를 수 있습니다.`,
        );
      }
      for (const item of this.missionChecklist) {
        if (item.done) {
          lines.push(`✅ ${item.description_ko}`);
        } else {
          const note =
            reportResponse?.checklist_notes.find((n) => n.id === item.id)?.note_ko ??
            "이번 세션에서는 다루지 않았어요.";
          lines.push(`❌ ${item.description_ko} — ${note}`);
        }
      }
    }

    lines.push("", "[이번 세션 교정 사항]");
    if (this.sessionCorrections.length === 0) {
      lines.push("이번 세션에는 교정 사항이 없었어요!");
    } else {
      for (const c of this.sessionCorrections) {
        lines.push(`- "${c.wrong}" → "${c.fixed}"`);
      }
    }

    lines.push("", "[다음에 연습하면 좋은 것]");
    const suggestions =
      reportResponse && reportResponse.focus_suggestions.length > 0
        ? reportResponse.focus_suggestions
        : ["꾸준히 연습하는 것만으로도 큰 도움이 돼요!"];
    for (const s of suggestions) {
      lines.push(`- ${s}`);
    }

    lines.push(divider);
    return lines.join("\n");
  }

  private async requestMemorySummaryOnce(transcript: string, retryNote?: string): Promise<MemorySummary> {
    const userContent = retryNote ? `${transcript}\n\n${retryNote}` : transcript;

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: buildMemorySummaryPrompt(this.learnerProfile.weak_expressions, this.learnerProfile.style_patterns),
      messages: [{ role: "user", content: userContent }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in summary response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    return JSON.parse(cleaned) as MemorySummary;
  }

  private async requestMemorySummary(transcript: string): Promise<MemorySummary | null> {
    return requestWithRetry(
      "Memory summary",
      (includeReformatNudge) => this.requestMemorySummaryOnce(transcript, includeReformatNudge ? REFORMAT_NUDGE : undefined),
      () => null,
    );
  }

  private async requestIssueDetectionOnce(
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
    const parsed = JSON.parse(cleaned) as Partial<IssueDetectionResponse>;

    const checklistUpdates = Array.isArray(parsed.checklist_updates)
      ? parsed.checklist_updates.filter((id): id is string => typeof id === "string")
      : [];
    const attemptedComplexPhrasing = parsed.attempted_complex_phrasing === true;
    const stylePatternNote =
      typeof parsed.style_pattern_note === "string" && parsed.style_pattern_note.trim() ? parsed.style_pattern_note : null;

    if (parsed.has_issue === true) {
      if (typeof parsed.tutor_line !== "string") {
        throw new Error("Issue-detection response has_issue=true but missing tutor_line");
      }
      return {
        has_issue: true,
        tutor_line: parsed.tutor_line,
        original_phrase: typeof parsed.original_phrase === "string" ? parsed.original_phrase : "(unspecified)",
        corrected_phrase: typeof parsed.corrected_phrase === "string" ? parsed.corrected_phrase : "(unspecified)",
        checklist_updates: checklistUpdates,
        attempted_complex_phrasing: attemptedComplexPhrasing,
        style_pattern_note: stylePatternNote,
      };
    }

    return {
      has_issue: false,
      tutor_line: null,
      original_phrase: null,
      corrected_phrase: null,
      checklist_updates: checklistUpdates,
      attempted_complex_phrasing: attemptedComplexPhrasing,
      style_pattern_note: stylePatternNote,
    };
  }

  private async requestIssueDetection(turnSystemPrompt: string): Promise<IssueDetectionResponse> {
    return requestWithRetry(
      "Issue-detection",
      (includeReformatNudge) =>
        this.requestIssueDetectionOnce(turnSystemPrompt, includeReformatNudge ? withReformatNudge(this.messages) : this.messages),
      () => {
        this.totalDetectionFailures += 1;
        return {
          has_issue: false,
          tutor_line: null,
          original_phrase: null,
          corrected_phrase: null,
          checklist_updates: [],
          attempted_complex_phrasing: false,
          style_pattern_note: null,
        };
      },
    );
  }

  private async requestStaffDialogueOnce(
    turnSystemPrompt: string,
    callMessages: Anthropic.MessageParam[],
  ): Promise<StaffDialogueResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: turnSystemPrompt,
      messages: callMessages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in staff-dialogue response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as Partial<StaffDialogueResponse>;
    if (typeof parsed.staff_line !== "string") {
      throw new Error("Staff-dialogue response missing staff_line");
    }

    return { staff_line: parsed.staff_line, scenario_complete: parsed.scenario_complete === true };
  }

  private async requestStaffDialogue(turnSystemPrompt: string): Promise<StaffDialogueResponse> {
    return requestWithRetry(
      "Staff-dialogue",
      (includeReformatNudge) =>
        this.requestStaffDialogueOnce(turnSystemPrompt, includeReformatNudge ? withReformatNudge(this.messages) : this.messages),
      () => ({ staff_line: "Sorry, could you say that again?", scenario_complete: false }),
    );
  }

  private async requestRepeatTurnOnce(
    turnSystemPrompt: string,
    callMessages: Anthropic.MessageParam[],
  ): Promise<RepeatTurnResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: turnSystemPrompt,
      messages: callMessages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in repeat-turn response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as Partial<RepeatTurnResponse>;
    if (typeof parsed.staff_line !== "string" || typeof parsed.tutor_line !== "string") {
      throw new Error("Repeat-turn response missing staff_line or tutor_line");
    }

    return { staff_line: parsed.staff_line, tutor_line: parsed.tutor_line, scenario_complete: parsed.scenario_complete === true };
  }

  // The reformat-nudge messages array is a local throwaway — it must never
  // mutate the shared `this.messages`, which is reused as real conversation
  // history on every future turn (withReformatNudge already returns a fresh
  // array).
  private async requestRepeatTurn(turnSystemPrompt: string): Promise<RepeatTurnResponse> {
    return requestWithRetry(
      "Repeat-turn",
      (includeReformatNudge) =>
        this.requestRepeatTurnOnce(turnSystemPrompt, includeReformatNudge ? withReformatNudge(this.messages) : this.messages),
      () => ({
        staff_line: "Sorry, could you say that again?",
        tutor_line: "좋아요!",
        scenario_complete: false,
      }),
    );
  }

  private async requestOpeningResponseOnce(
    turnSystemPrompt: string,
    callMessages: Anthropic.MessageParam[],
  ): Promise<OpeningResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: turnSystemPrompt,
      messages: callMessages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in opening response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as Partial<OpeningResponse>;
    if (typeof parsed.mission_briefing !== "string" || typeof parsed.staff_line !== "string") {
      throw new Error("Opening response missing mission_briefing or staff_line");
    }

    const rawChecklist: unknown[] = Array.isArray(parsed.mission_checklist) ? parsed.mission_checklist : [];
    const checklist: MissionChecklistItem[] = rawChecklist
      .filter((item): item is Omit<MissionChecklistItem, "done"> => {
        const candidate = item as Partial<MissionChecklistItem> | null;
        return (
          typeof candidate?.id === "string" &&
          typeof candidate?.description_ko === "string" &&
          (candidate?.type === "fact" || candidate?.type === "situation")
        );
      })
      .map((item) => ({ ...item, done: false }));

    return { mission_briefing: parsed.mission_briefing, staff_line: parsed.staff_line, mission_checklist: checklist };
  }

  private async requestOpeningResponse(turnSystemPrompt: string): Promise<OpeningResponse> {
    return requestWithRetry(
      "Opening response",
      (includeReformatNudge) =>
        this.requestOpeningResponseOnce(turnSystemPrompt, includeReformatNudge ? withReformatNudge(this.messages) : this.messages),
      () => ({
        mission_briefing: "오늘의 미션을 불러오지 못했어요 — 자유롭게 대화를 시작해보세요!",
        staff_line: "Hi there! Welcome — how can I help you today?",
        mission_checklist: [],
      }),
    );
  }

  private async requestSessionReportOnce(reportSystemPrompt: string): Promise<SessionReportResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: reportSystemPrompt,
      messages: [{ role: "user", content: "Write the report now." }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) {
      throw new Error("No text block in session-report response");
    }

    const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as Partial<SessionReportResponse>;

    const checklistNotes = Array.isArray(parsed.checklist_notes)
      ? parsed.checklist_notes.filter(
          (n): n is { id: string; note_ko: string } => typeof n?.id === "string" && typeof n?.note_ko === "string",
        )
      : [];
    const focusSuggestions = Array.isArray(parsed.focus_suggestions)
      ? parsed.focus_suggestions.filter((s): s is string => typeof s === "string")
      : [];

    return { checklist_notes: checklistNotes, focus_suggestions: focusSuggestions };
  }

  // Returns null if every attempt fails — the report still gets built using
  // just the code-tracked facts (checklist done/not-done, corrections), only
  // the natural-language notes/suggestions are dropped.
  private async requestSessionReport(): Promise<SessionReportResponse | null> {
    if (this.getLoggableMessages().length === 0) return null;

    const reportSystemPrompt = buildSessionReportPrompt(
      this.missionChecklist,
      this.sessionCorrections,
      this.learnerProfile.weak_expressions,
      this.learnerProfile.style_patterns,
    );
    return requestWithRetry(
      "Session-report",
      (includeReformatNudge) =>
        this.requestSessionReportOnce(includeReformatNudge ? `${reportSystemPrompt}\n\n${REFORMAT_NUDGE}` : reportSystemPrompt),
      () => null,
    );
  }
}

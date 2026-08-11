import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getParticipantsDir } from "./paths.js";

export interface SessionSegment {
  label: string; // e.g. "Staff", "Mission", "Tutor(KO)" — rendered as its own labeled line
  text: string;
}

export interface SessionTurn {
  role: "user" | "assistant";
  text: string; // plain fallback rendering, used when segments isn't set
  // When an assistant turn actually mixes distinct speakers/voices (in-character
  // Staff dialogue vs. out-of-character Korean mission briefing or tutor
  // feedback), segments lets each get its own labeled line instead of being
  // silently concatenated under one "Staff:" label — set at the point the
  // content is generated (chatSession.ts) rather than reconstructed later by
  // parsing the merged text, which would be fragile.
  segments?: SessionSegment[];
}

export interface SessionLogResult {
  baseName: string;
  sessionNumber: number | null; // null for the fixed "pretest" basename
}

const participantsDir = getParticipantsDir();

// Scans the participant's own directory rather than tracking a counter
// anywhere (no DB column, no state file) — stateless, and self-resets to 1
// after archiveAndReset.ts moves the directory away.
function nextSessionNumber(participantDir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(participantDir);
  } catch {
    return 1; // directory doesn't exist yet — this is the first session
  }
  const numbers = entries
    .map((name) => /^session-(\d+)-/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

// One file per session (or one fixed pretest.md), NOT an append target —
// each CLI run calls this exactly once at the end, so a "session" here is a
// whole run. scenarioId "pretest" is a one-shot special case, safe because
// chat.ts's learnerExists guard ensures runPretest only ever fires once per
// learner; if that guard were ever bypassed, a second pretest run would
// silently overwrite pretest.md rather than error.
//
// Returns the baseName/sessionNumber actually used (or null if nothing was
// written) so a caller can hand the exact same baseName to writeSessionData
// below — recomputing nextSessionNumber a second time would race against the
// .md file just written here and produce a mismatched, incremented number.
export function writeSessionLog(params: { learnerId: string; scenarioId: string; turns: SessionTurn[] }): SessionLogResult | null {
  const { learnerId, scenarioId, turns } = params;
  if (turns.length === 0) return null;

  try {
    const participantDir = join(participantsDir, learnerId);
    mkdirSync(participantDir, { recursive: true });

    const sessionNumber = scenarioId === "pretest" ? null : nextSessionNumber(participantDir);
    const baseName = scenarioId === "pretest" ? "pretest" : `session-${String(sessionNumber).padStart(2, "0")}-${scenarioId}`;
    const logPath = join(participantDir, `${baseName}.md`);

    const header = `# Session — ${new Date().toISOString()} (scenario: ${scenarioId})\n\n`;
    const body = turns
      .map((t) =>
        t.segments && t.segments.length > 0
          ? t.segments.map((s) => `**${s.label}:** ${s.text}`).join("\n\n")
          : `**${t.role === "user" ? "You" : "Staff"}:** ${t.text}`,
      )
      .join("\n\n");

    writeFileSync(logPath, header + body + "\n", "utf-8");
    return { baseName, sessionNumber };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to write session log, continuing: ${message}`);
    return null;
  }
}

// Structured counterpart to writeSessionLog, written under the same baseName
// (same participant dir, .json instead of .md) — for aggregate analysis
// across participants. Same best-effort posture: warns and continues, never
// throws.
//
// is_test_run defaults true (treated as test data) unless IS_TEST_RUN is
// explicitly set to the literal string "false" — real study data requires an
// explicit opt-out rather than every dev/local/smoke-test run needing to
// remember to opt in, so a forgotten env var fails safe toward "exclude from
// analysis" rather than silently contaminating the real dataset. Injected
// here (not at each chatSession.ts/pretestSession.ts call site) so both
// pretest.json and session-*.json always get it with no risk of one call
// site forgetting to set it.
export function writeSessionData(learnerId: string, baseName: string, data: unknown): void {
  try {
    const participantDir = join(participantsDir, learnerId);
    mkdirSync(participantDir, { recursive: true });
    const payload = { ...(data as Record<string, unknown>), is_test_run: process.env.IS_TEST_RUN !== "false" };
    writeFileSync(join(participantDir, `${baseName}.json`), JSON.stringify(payload, null, 2), "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to write session data, continuing: ${message}`);
  }
}

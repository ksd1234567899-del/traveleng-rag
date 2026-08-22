// At-a-glance alpha-test progress table: which participants have completed
// which sessions, and their current level — read directly from the session
// JSON logs already written by ChatSession/PretestSession (same source
// progress.ts uses), no SQLite involved. Run against production via
// `railway ssh -- node dist/scripts/checkProgress.js`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getParticipantsDir } from "../lib/paths.js";

// Folder names used for ad-hoc/manual testing rather than real participants —
// extend this list as new throwaway account names show up.
const TEST_ACCOUNT_PATTERNS: RegExp[] = [
  /^lastest\d*$/i, // lastest, lastest2, ...
  /^test\d*$/i, // test, test1, testuser...
  /^0+$/, // 000000, 0, ...
  /^_/, // _healthcheck_..., or any other underscore-prefixed system/synthetic id
];

function isTestAccount(learnerId: string): boolean {
  return TEST_ACCOUNT_PATTERNS.some((pattern) => pattern.test(learnerId));
}

interface SessionEntry {
  sessionNumber: number;
  scenario: string;
  visitNumber: number;
  complete: boolean;
  levelAfter: string | null;
  timestamp: string;
}

interface PretestEntry {
  complete: boolean;
  startingLevel: string | null;
  timestamp: string;
}

interface ParticipantData {
  learnerId: string;
  pretest: PretestEntry | null;
  sessions: SessionEntry[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // missing/corrupt file — skip rather than fail the whole report
  }
}

function loadParticipant(learnerId: string, participantDir: string): ParticipantData {
  let entries: string[];
  try {
    entries = readdirSync(participantDir);
  } catch {
    entries = [];
  }

  let pretest: PretestEntry | null = null;
  const sessions: SessionEntry[] = [];

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const data = readJson(join(participantDir, name));
    if (!data) continue;

    if (name === "pretest.json") {
      pretest = {
        complete: data.session_end_type === "auto",
        startingLevel: typeof data.starting_level === "string" ? data.starting_level : null,
        timestamp: typeof data.timestamp === "string" ? data.timestamp : "",
      };
      continue;
    }

    if (typeof data.scenario === "string" && typeof data.session_number === "number") {
      sessions.push({
        sessionNumber: data.session_number,
        scenario: data.scenario,
        visitNumber: typeof data.scenario_visit_number === "number" ? data.scenario_visit_number : 1,
        complete: data.session_end_type === "auto",
        levelAfter: typeof data.level_after === "string" ? data.level_after : null,
        timestamp: typeof data.timestamp === "string" ? data.timestamp : "",
      });
    }
  }

  sessions.sort((a, b) => a.sessionNumber - b.sessionNumber);
  return { learnerId, pretest, sessions };
}

// The set of scenario+visit columns to display, and the order to display them
// in, is derived from the data itself (session_number position) rather than
// hardcoded — so the table adapts automatically if the study protocol
// changes. Ties at a given session_number (different participants completing
// different scenarios at the same numeric slot) are resolved by majority
// vote, first-seen order breaking further ties.
function deriveColumns(participants: ParticipantData[]): { sessionNumber: number; label: string }[] {
  const labelCountsByNumber = new Map<number, Map<string, number>>();

  for (const p of participants) {
    for (const s of p.sessions) {
      const label = `${s.scenario}${s.visitNumber}`;
      let counts = labelCountsByNumber.get(s.sessionNumber);
      if (!counts) {
        counts = new Map();
        labelCountsByNumber.set(s.sessionNumber, counts);
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  const columns: { sessionNumber: number; label: string }[] = [];
  const sortedNumbers = [...labelCountsByNumber.keys()].sort((a, b) => a - b);
  for (const sessionNumber of sortedNumbers) {
    const counts = labelCountsByNumber.get(sessionNumber)!;
    let bestLabel = "";
    let bestCount = -1;
    for (const [label, count] of counts) {
      if (count > bestCount) {
        bestLabel = label;
        bestCount = count;
      }
    }
    columns.push({ sessionNumber, label: bestLabel });
  }
  return columns;
}

// "Current level" = level from whichever record (pretest or a completed
// session) has the most recent timestamp — falls back to pretest's starting
// level if no scenario session has happened yet, and "-" if there's no data
// at all.
function currentLevel(p: ParticipantData): string {
  let bestTimestamp = "";
  let bestLevel: string | null = null;

  if (p.pretest?.startingLevel) {
    bestTimestamp = p.pretest.timestamp;
    bestLevel = p.pretest.startingLevel;
  }
  for (const s of p.sessions) {
    if (s.levelAfter && s.timestamp >= bestTimestamp) {
      bestTimestamp = s.timestamp;
      bestLevel = s.levelAfter;
    }
  }
  return bestLevel ?? "-";
}

function center(text: string, width: number): string {
  const pad = Math.max(width - text.length, 0);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const headerLine = headers.map((h, i) => center(h, widths[i])).join(" | ");
  const separatorLine = widths.map((w) => "-".repeat(w + 2)).join("|");
  console.log(headerLine);
  console.log(separatorLine);
  for (const row of rows) {
    console.log(row.map((cell, i) => center(cell, widths[i])).join(" | "));
  }
}

function main(): void {
  const participantsDir = getParticipantsDir();

  let allEntries: string[];
  try {
    allEntries = readdirSync(participantsDir);
  } catch {
    console.log("No participant data found.");
    return;
  }

  const learnerIds = allEntries
    .filter((name) => statSync(join(participantsDir, name)).isDirectory())
    .filter((name) => !isTestAccount(name))
    .sort();

  if (learnerIds.length === 0) {
    console.log("No participant data found (after excluding test accounts).");
    return;
  }

  const participants = learnerIds.map((id) => loadParticipant(id, join(participantsDir, id)));
  const columns = deriveColumns(participants);

  const today = new Date().toISOString().slice(0, 10);
  console.log(`=== Alpha Test Progress (${today}) ===\n`);

  const headers = ["participant", "pretest", ...columns.map((c) => c.label), "level"];
  const rows = participants.map((p) => {
    const pretestCell = p.pretest?.complete ? "✅" : "❌";
    const sessionCells = columns.map((col) => {
      const match = p.sessions.find((s) => s.sessionNumber === col.sessionNumber);
      return match?.complete ? "✅" : "❌";
    });
    return [p.learnerId, pretestCell, ...sessionCells, currentLevel(p)];
  });

  printTable(headers, rows);

  const totalCompletedSessions = participants.reduce((sum, p) => sum + p.sessions.filter((s) => s.complete).length, 0);
  console.log(`\nTotal completed sessions: ${totalCompletedSessions} (across ${participants.length} participant(s))`);
}

main();

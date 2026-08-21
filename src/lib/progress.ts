import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getParticipantsDir } from "./paths.js";
import { getOrCreateLearner, learnerExists } from "./memory.js";

export interface CompletedSession {
  scenario: string;
  scenarioVisitNumber: number | null;
  sessionNumber: number;
  completedAt: string;
}

export interface LearnerProgress {
  learnerId: string;
  level: string;
  completedSessions: CompletedSession[];
  pretestCompleted: boolean;
}

// Reads exclusively from session-*.json / pretest.json already written by
// ChatSession/PretestSession, plus the learner's current level from sqlite —
// no new storage, this is a read-only projection over existing logs.
export function getLearnerProgress(learnerId: string): LearnerProgress | null {
  if (!learnerExists(learnerId)) return null; // don't auto-create a learner row from a progress check

  const profile = getOrCreateLearner(learnerId);
  const participantDir = join(getParticipantsDir(), learnerId);

  let entries: string[];
  try {
    entries = readdirSync(participantDir);
  } catch {
    entries = []; // no sessions logged yet — valid, not an error
  }

  const completedSessions: CompletedSession[] = [];
  let pretestCompleted = false;

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(join(participantDir, name), "utf-8"));
    } catch {
      continue; // skip unreadable/corrupt files rather than failing the whole request
    }

    if (name === "pretest.json") {
      if (data.session_end_type === "auto") pretestCompleted = true;
      continue;
    }

    if (data.session_end_type === "auto" && typeof data.scenario === "string" && typeof data.session_number === "number") {
      completedSessions.push({
        scenario: data.scenario,
        scenarioVisitNumber: typeof data.scenario_visit_number === "number" ? data.scenario_visit_number : null,
        sessionNumber: data.session_number,
        completedAt: typeof data.timestamp === "string" ? data.timestamp : "",
      });
    }
  }

  completedSessions.sort((a, b) => a.sessionNumber - b.sessionNumber);

  return { learnerId, level: profile.level, completedSessions, pretestCompleted };
}

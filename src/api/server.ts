import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { ChatSession } from "../lib/chatSession.js";
import { PretestSession } from "../lib/pretestSession.js";
import { learnerExists } from "../lib/memory.js";

const PORT = Number(process.env.PORT ?? 3000);
// Comma-separated list of allowed origins, or unset for permissive (fine for
// a short participant study; tighten via env var if needed).
const CORS_ORIGIN = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim());

// A session past this long without a turn is treated as abandoned and
// auto-finalized (so its data isn't lost/left dangling) rather than kept
// alive forever — cheap enough at this scale that no external store is
// needed, see IDLE_SWEEP_INTERVAL_MS below.
const IDLE_TIMEOUT_MS = 45 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type SessionEntry =
  | { kind: "pretest"; session: PretestSession; lastActivityAt: number }
  | { kind: "scenario"; session: ChatSession; lastActivityAt: number };

// One process handles every active participant's session, so state lives in
// a plain Map keyed by sessionId — fine at this scale (a 15-participant
// study), same tradeoff the task called out explicitly (no Redis needed).
// A server restart drops any session that hasn't been finalized yet;
// everything already finalized is already durably on disk (sqlite/log
// files), untouched by this.
const sessions = new Map<string, SessionEntry>();

function touch(entry: SessionEntry): void {
  entry.lastActivityAt = Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const entry of sessions.values()) {
    if (entry.session.ended) continue;
    if (now - entry.lastActivityAt < IDLE_TIMEOUT_MS) continue;
    entry.session.end().catch((error) => {
      console.error("Failed to auto-finalize idle session:", error);
    });
  }
}, IDLE_SWEEP_INTERVAL_MS).unref();

const app = express();
app.use(express.json());
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : {}));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/session/start", async (req: Request, res: Response) => {
  const { learnerId, scenario } = req.body ?? {};
  if (typeof learnerId !== "string" || !learnerId.trim()) {
    res.status(400).json({ error: "learnerId is required" });
    return;
  }

  try {
    if (!learnerExists(learnerId)) {
      const { session, opening } = await PretestSession.start(learnerId);
      const sessionId = randomUUID();
      sessions.set(sessionId, { kind: "pretest", session, lastActivityAt: Date.now() });
      res.json({
        sessionId,
        kind: "pretest",
        partnerLine: opening.partnerLine,
      });
      return;
    }

    if (typeof scenario !== "string" || !scenario.trim()) {
      // No default fallback, deliberately — the study requires participants
      // to follow a specific scenario sequence, and a silent default here
      // would let a frontend bug (forgetting to send the next scenario in
      // sequence) pass unnoticed instead of surfacing as a clear error.
      res.status(400).json({ error: "scenario is required" });
      return;
    }

    const { session, opening } = await ChatSession.start(learnerId, scenario);
    const sessionId = randomUUID();
    sessions.set(sessionId, { kind: "scenario", session, lastActivityAt: Date.now() });
    res.json({
      sessionId,
      kind: "scenario",
      scenario: session.scenario.id,
      missionBriefing: opening.missionBriefing,
      staffLine: opening.staffLine,
      missionChecklist: opening.missionChecklist,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

app.post("/session/message", async (req: Request, res: Response) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "sessionId and message are required" });
    return;
  }

  const entry = sessions.get(sessionId);
  if (!entry) {
    res.status(404).json({ error: "Unknown sessionId" });
    return;
  }
  if (entry.session.ended) {
    res.status(409).json({ error: "Session has already ended", report: entry.session.report });
    return;
  }

  try {
    touch(entry);
    if (entry.kind === "pretest") {
      const result = await entry.session.sendMessage(message);
      res.json({
        kind: "pretest",
        partnerLine: result.partnerLine,
        pretestComplete: result.pretestComplete,
        report: result.report,
      });
      return;
    }

    const result = await entry.session.sendMessage(message);
    res.json({
      kind: "scenario",
      staffLine: result.staffLine,
      tutorLine: result.tutorLine,
      styleNote: result.styleNote,
      scenarioComplete: result.scenarioComplete,
      awaitingRepeat: result.awaitingRepeat,
      missionChecklist: result.missionChecklist,
      report: result.report,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.post("/session/end", async (req: Request, res: Response) => {
  const { sessionId } = req.body ?? {};
  if (typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  const entry = sessions.get(sessionId);
  if (!entry) {
    res.status(404).json({ error: "Unknown sessionId" });
    return;
  }

  try {
    const report = await entry.session.end();
    res.json({ kind: entry.kind, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.get("/session/:sessionId/report", (req: Request, res: Response) => {
  const entry = sessions.get(req.params.sessionId);
  if (!entry) {
    res.status(404).json({ error: "Unknown sessionId" });
    return;
  }
  if (!entry.session.ended) {
    res.status(409).json({ error: "Session has not ended yet" });
    return;
  }
  res.json({ kind: entry.kind, report: entry.session.report });
});

app.listen(PORT, () => {
  console.log(`traveleng-rag API server listening on port ${PORT}`);
});

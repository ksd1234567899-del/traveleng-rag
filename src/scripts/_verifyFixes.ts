import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildIssueDetectionInstruction,
  buildIssueDetectionSystemPrompt,
  buildMissionChecklistBlock,
  buildRetrievedContextBlock,
  buildStaffDialogueInstruction,
  type MissionChecklistItem,
  type Scenario,
} from "../lib/prompts.js";
import type { LearnerProfile } from "../lib/memory.js";
import type { RetrievedContext } from "../lib/retrieval.js";

const client = new Anthropic();

const scenario: Scenario = {
  id: "airport",
  title: "Airport Check-in",
  description:
    "You are an airline check-in staff member at the departure counter. The user is a traveler checking in for their flight. Guide them naturally through check-in: greet them, ask for their passport and booking reference, confirm their luggage, ask about seat preference (window or aisle), and hand over the boarding pass. Stay in character throughout.",
  missionBasics: "destination, bag(s), seat preference",
  missionElementPool: ["overweight or oversized baggage"],
  completionExample: "boarding pass issued, bags checked, situation fully resolved",
};
const level = "B1";
const issueDetectionSystemPrompt = buildIssueDetectionSystemPrompt(scenario, level);

function emptyContext(learnerProfile: LearnerProfile | null = null): RetrievedContext {
  return { mistakes: [], utterances: [], knowledge: [], learnerProfile };
}

async function callJSON(systemPrompt: string, messages: Anthropic.MessageParam[]): Promise<any> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("no text block");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
  return JSON.parse(cleaned);
}

async function runDetection(
  label: string,
  context: RetrievedContext,
  checklist: MissionChecklistItem[],
  convo: Anthropic.MessageParam[],
) {
  const retrievedContextBlock = buildRetrievedContextBlock(context);
  const checklistBlock = buildMissionChecklistBlock(checklist);
  const detectionSystemPrompt =
    issueDetectionSystemPrompt + "\n\n" + retrievedContextBlock + "\n\n" + checklistBlock + "\n\n" + buildIssueDetectionInstruction();

  const detection = await callJSON(detectionSystemPrompt, convo);

  console.log(`\n=== ${label} ===`);
  console.log("Learner's last line:", JSON.stringify(convo[convo.length - 1].content));
  console.log("has_issue:", detection.has_issue);
  console.log("attempted_complex_phrasing:", detection.attempted_complex_phrasing);
  console.log("style_pattern_note:", detection.style_pattern_note);
  if (detection.has_issue) {
    console.log("[튜터]:", detection.tutor_line);
    console.log("(original_phrase:", detection.original_phrase, "| corrected_phrase:", detection.corrected_phrase, ")");
    console.log("Staff: (silent this turn — Call B never runs per the code-enforced split)");
  } else {
    const staffSystemPrompt =
      "You are an English-speaking practice partner helping a language learner rehearse real-world travel conversations.\n\nScenario: Airport Check-in\n" +
      scenario.description +
      "\n\nGuidelines:\n- Stay fully in character; speak like a real staff member.\n- Keep replies short and natural.\n- You are ONLY ever writing Staff's own in-character dialogue — never a correction.\n\n" +
      retrievedContextBlock +
      "\n\n" +
      checklistBlock +
      "\n\n" +
      buildStaffDialogueInstruction(scenario.completionExample);
    const staffResp = await callJSON(staffSystemPrompt, convo);
    console.log("[튜터]: (silent — no issue found)");
    console.log("Staff:", staffResp.staff_line);
  }
}

async function main() {
  // Case 1: bare "john" answering a name question — should now flag.
  await runDetection(
    "Case 1: bare name fragment (\"john\")",
    emptyContext(null),
    [],
    [
      { role: "assistant", content: "Staff: Welcome! Could I get your name, please?" },
      { role: "user", content: "john" },
    ],
  );

  // Case 2: same fragment pattern, previously seen 2x before (light tier).
  const pattern = "Answers questions with a single bare word instead of a full sentence";
  const profileCount2: LearnerProfile = {
    learner_id: "dev_1",
    level,
    weak_expressions: [{ pattern, count: 2 }],
    style_patterns: [],
    last_studied_at: null,
    last_session_summary: null,
  };
  await runDetection(
    "Case 2: repeated fragment pattern, count=2 (light-tier expected)",
    {
      mistakes: [
        { id: "m1", text: pattern, metadata: { type: "user_mistake", learner_id: "dev_1" }, score: 0.9 },
      ],
      utterances: [],
      knowledge: [],
      learnerProfile: profileCount2,
    },
    [],
    [
      { role: "assistant", content: "Staff: And what's your final destination today?" },
      { role: "user", content: "sarah" },
    ],
  );

  // Case 3: same pattern, previously seen 4x before (strong tier).
  const profileCount4: LearnerProfile = { ...profileCount2, weak_expressions: [{ pattern, count: 4 }] };
  await runDetection(
    "Case 3: repeated fragment pattern, count=4 (strong-tier expected)",
    {
      mistakes: [
        { id: "m1", text: pattern, metadata: { type: "user_mistake", learner_id: "dev_1" }, score: 0.9 },
      ],
      utterances: [],
      knowledge: [],
      learnerProfile: profileCount4,
    },
    [],
    [
      { role: "assistant", content: "Staff: And what's your final destination today?" },
      { role: "user", content: "paris" },
    ],
  );

  // Case 4: handoff phrase, NO pending situation item — should NOT flag.
  const checklistNoPendingSituation: MissionChecklistItem[] = [
    { id: "destination", description_ko: "목적지 말하기", type: "fact", done: false },
    { id: "find_passport", description_ko: "여권 찾는 상황 설명하기", type: "situation", done: true },
  ];
  await runDetection(
    'Case 4: "here you are" handoff, no pending situation (should NOT flag)',
    emptyContext(null),
    checklistNoPendingSituation,
    [
      { role: "assistant", content: "Staff: Could I see your passport, please?" },
      { role: "user", content: "Here you are." },
    ],
  );

  // Case 5: handoff phrase, WITH a pending "situation" item — should flag.
  const checklistPendingSituation: MissionChecklistItem[] = [
    { id: "destination", description_ko: "목적지 말하기", type: "fact", done: false },
    { id: "find_passport", description_ko: "여권 찾는 상황 설명하기 (시간이 걸림)", type: "situation", done: false },
  ];
  await runDetection(
    'Case 5: "here you are" handoff after searching, pending situation item (should flag)',
    emptyContext(null),
    checklistPendingSituation,
    [
      { role: "assistant", content: "Staff: Could I see your passport, please?" },
      { role: "user", content: "Um, one second..." },
      { role: "assistant", content: "Staff: Take your time." },
      { role: "user", content: "Here you are." },
    ],
  );

  // Case 6: ambitious/polite phrasing WITH a minor slip — the crux case the
  // fluency-signal feature depends on: has_issue and attempted_complex_phrasing
  // must NOT be conflated. Expect has_issue=true (fixing "their's") AND
  // attempted_complex_phrasing=true (connective "if", polite "could I possibly").
  await runDetection(
    'Case 6: complex/polite phrasing WITH a minor slip (expect has_issue=true AND attempted_complex_phrasing=true)',
    emptyContext(null),
    [],
    [
      { role: "assistant", content: "Staff: Sure, let me check what's available." },
      { role: "user", content: "Could I possibly get a window seat, if their's one available?" },
    ],
  );

  // Case 7: grammatically correct but minimal/safe declarative — the other
  // half of the crux case. Expect has_issue=false (nothing wrong) AND
  // attempted_complex_phrasing=false (no connective, no subordinate clause,
  // no polite indirect form — just a bare correct declarative).
  await runDetection(
    'Case 7: minimal correct declarative (expect has_issue=false AND attempted_complex_phrasing=false)',
    emptyContext(null),
    [],
    [
      { role: "assistant", content: "Staff: What can I get for you?" },
      { role: "user", content: "I want water." },
    ],
  );

  // Case 8/9: known style pattern at count=2 vs count=4 — exercises
  // style_pattern_note tiering directly, since staleness means a real
  // surfaced note otherwise requires chaining 3 real sessions (see the plan's
  // design decision #2). Both expect style_pattern_note non-null (light vs.
  // more direct framing) since the learner's message clearly exhibits the
  // listed habit again.
  const stylePattern = "Consistently uses basic verbs like 'get'/'want' instead of more precise or polite alternatives";
  const profileStyleCount2: LearnerProfile = {
    learner_id: "dev_1",
    level,
    weak_expressions: [],
    style_patterns: [{ pattern: stylePattern, count: 2 }],
    last_studied_at: null,
    last_session_summary: null,
  };
  await runDetection(
    "Case 8: known style pattern at count=2 (light-tier framing expected)",
    { mistakes: [], utterances: [], knowledge: [], learnerProfile: profileStyleCount2 },
    [],
    [
      { role: "assistant", content: "Staff: What would you like to drink?" },
      { role: "user", content: "I want a coffee." },
    ],
  );

  const profileStyleCount4: LearnerProfile = {
    ...profileStyleCount2,
    style_patterns: [{ pattern: stylePattern, count: 4 }],
  };
  await runDetection(
    "Case 9: known style pattern at count=4 (stronger, more direct framing expected)",
    { mistakes: [], utterances: [], knowledge: [], learnerProfile: profileStyleCount4 },
    [],
    [
      { role: "assistant", content: "Staff: What would you like to drink?" },
      { role: "user", content: "I want a coffee." },
    ],
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

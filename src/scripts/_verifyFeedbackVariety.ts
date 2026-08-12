import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildIssueDetectionInstruction,
  buildIssueDetectionSystemPrompt,
  buildMissionChecklistBlock,
  buildRetrievedContextBlock,
  type MissionChecklistItem,
  type Scenario,
} from "../lib/prompts.js";
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

const emptyChecklist: MissionChecklistItem[] = [];

async function callJSONOnce(systemPrompt: string, messages: Anthropic.MessageParam[]): Promise<any> {
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

async function callJSON(systemPrompt: string, messages: Anthropic.MessageParam[]): Promise<any> {
  try {
    return await callJSONOnce(systemPrompt, messages);
  } catch {
    const retryMessages: Anthropic.MessageParam[] = [
      ...messages,
      {
        role: "user",
        content:
          "Your previous reply was not valid JSON. Respond again with ONLY the raw JSON object described above — no markdown fences, no commentary, nothing else.",
      },
    ];
    return callJSONOnce(systemPrompt, retryMessages);
  }
}

async function detect(
  label: string,
  level: string,
  context: RetrievedContext,
  checklist: MissionChecklistItem[],
  messages: Anthropic.MessageParam[],
): Promise<any> {
  const systemPrompt = buildIssueDetectionSystemPrompt(scenario, level);
  const retrievedBlock = buildRetrievedContextBlock(context);
  const checklistBlock = buildMissionChecklistBlock(checklist);
  const fullSystem = systemPrompt + "\n\n" + retrievedBlock + "\n\n" + checklistBlock + "\n\n" + buildIssueDetectionInstruction();

  const result = await callJSON(fullSystem, messages);
  console.log(`\n--- ${label} ---`);
  console.log("has_issue:", result.has_issue, "| mistake_type:", result.mistake_type);
  console.log("tutor_line:", result.tutor_line);
  if (result.style_pattern_note) console.log("style_pattern_note:", result.style_pattern_note);
  return result;
}

async function main() {
  const empty = (learnerProfile: RetrievedContext["learnerProfile"] = null): RetrievedContext => ({
    mistakes: [],
    utterances: [],
    knowledge: [],
    learnerProfile,
  });

  // --- Spelling: exact "'<wrong>' -> '<fixed>'" format, nothing else added.
  await detect("Spelling (typo)", "B1", empty(), emptyChecklist, [
    { role: "assistant", content: "Would you like a window or aisle seat?" },
    { role: "user", content: "widnow seat please" },
  ]);

  // --- Vocabulary, count 1 then count 3 (tier 2-3) for the SAME learner —
  // checks the closing-nudge varies between the two, not the same phrase twice.
  const carrierMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "Are you checking any bags in today?" },
    { role: "user", content: "yes, i have one carrier" },
  ];
  const v1 = await detect("Vocabulary (count 1)", "B1", empty(), emptyChecklist, carrierMsgs);
  carrierMsgs.push({ role: "assistant", content: `[튜터]: ${v1.tutor_line}` });
  carrierMsgs.push({ role: "assistant", content: "Got it. And a window or aisle seat?" });
  carrierMsgs.push({ role: "user", content: "i have one carrier again just to check" });

  const carrierPattern = { pattern: "using 'carrier' to mean a suitcase/bag, instead of the company/person sense", count: 2 };
  const vocabProfile3: RetrievedContext["learnerProfile"] = {
    learner_id: "learner",
    level: "B1",
    weak_expressions: [carrierPattern],
    style_patterns: [],
    last_studied_at: null,
    last_session_summary: null,
  };
  const vocabContext3: RetrievedContext = {
    mistakes: [{ id: "m1", text: carrierPattern.pattern, metadata: { type: "user_mistake" }, score: 0.9 }],
    utterances: [],
    knowledge: [],
    learnerProfile: vocabProfile3,
  };
  await detect("Vocabulary (seen 2x before -> tier 2-3, closing nudge should differ from below)", "B1", vocabContext3, emptyChecklist, carrierMsgs);

  // --- Grammar, count 1 then count 4+ (tier 4+) for a different pattern —
  // separate learner so this run doesn't depend on the above.
  await detect("Grammar (count 1)", "A2", empty(), emptyChecklist, [
    { role: "assistant", content: "Where are you headed today?" },
    { role: "user", content: "i go to paris for vacation" },
  ]);

  const dropAuxPattern = { pattern: "dropping the auxiliary verb in questions/statements (e.g. 'I go' instead of 'I'm going')", count: 4 };
  const grammarProfile4: RetrievedContext["learnerProfile"] = {
    learner_id: "learner",
    level: "A2",
    weak_expressions: [dropAuxPattern],
    style_patterns: [],
    last_studied_at: null,
    last_session_summary: null,
  };
  const grammarContext4: RetrievedContext = {
    mistakes: [{ id: "m2", text: dropAuxPattern.pattern, metadata: { type: "user_mistake" }, score: 0.9 }],
    utterances: [],
    knowledge: [],
    learnerProfile: grammarProfile4,
  };
  await detect("Grammar (seen 4x before -> tier 4+)", "A2", grammarContext4, emptyChecklist, [
    { role: "assistant", content: "Where are you headed today?" },
    { role: "user", content: "i go to paris for vacation" },
  ]);

  // --- Unnatural phrasing: bare fragment (soft "~해보자" nudge, no reason needed).
  await detect("Unnatural phrasing (bare fragment)", "A2", empty(), emptyChecklist, [
    { role: "assistant", content: "What terminal are you at?" },
    { role: "user", content: "here" },
  ]);

  // --- Unnatural phrasing: pending situation item glossed over — must name the
  // SPECIFIC situation from the checklist item, not a generic "타이밍이었어" wrapper.
  const situationChecklist: MissionChecklistItem[] = [
    { id: "find_passport", description_ko: "여권을 찾는 데 시간이 걸리는 상황을 설명하기", type: "situation", done: false },
  ];
  await detect("Unnatural phrasing (situation glossed over)", "A2", empty(), situationChecklist, [
    { role: "assistant", content: "Could I see your passport, please?" },
    { role: "user", content: "um, one second" },
    { role: "assistant", content: "Take your time." },
    { role: "user", content: "here you go" },
  ]);

  // --- Unnatural phrasing: grammatically correct but blunt/rude for the
  // context — checks the softened "무례하게 들릴 수 있어" framing, not a flat
  // "that's rude" verdict, and no empathy/emoji despite the softer wording.
  await detect("Unnatural phrasing (blunt/rude, grammatically correct)", "B2", empty(), emptyChecklist, [
    { role: "assistant", content: "Sure, I can help — what would you like?" },
    { role: "user", content: "Give me window seat now, I don't want to wait." },
  ]);

  // --- style_pattern_note, count 2 then count 4+ — checks the dry tone and
  // varied closing nudge apply here too, matching tutor_line's tiering.
  const overusedGet2 = { pattern: "overusing the verb 'get' instead of more precise/polite alternatives", count: 2 };
  const styleProfile2: RetrievedContext["learnerProfile"] = {
    learner_id: "learner",
    level: "B1",
    weak_expressions: [],
    style_patterns: [overusedGet2],
    last_studied_at: null,
    last_session_summary: null,
  };
  const styleContext2: RetrievedContext = { mistakes: [], utterances: [], knowledge: [], learnerProfile: styleProfile2 };
  await detect("style_pattern_note (count 2)", "B1", styleContext2, emptyChecklist, [
    { role: "assistant", content: "Sure, what would you like to order?" },
    { role: "user", content: "Can I get a coffee, please?" },
  ]);

  const styleProfile4 = { ...styleProfile2, style_patterns: [{ ...overusedGet2, count: 4 }] };
  const styleContext4: RetrievedContext = { ...styleContext2, learnerProfile: styleProfile4 };
  await detect("style_pattern_note (count 4+)", "B1", styleContext4, emptyChecklist, [
    { role: "assistant", content: "Anything else for you?" },
    { role: "user", content: "Can I get the check too?" },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
  learnerId: string,
  addressByName: boolean,
  context: RetrievedContext,
  checklist: MissionChecklistItem[],
  messages: Anthropic.MessageParam[],
): Promise<any> {
  const systemPrompt = buildIssueDetectionSystemPrompt(scenario, level);
  const retrievedBlock = buildRetrievedContextBlock(context);
  const checklistBlock = buildMissionChecklistBlock(checklist);
  const fullSystem =
    systemPrompt + "\n\n" + retrievedBlock + "\n\n" + checklistBlock + "\n\n" + buildIssueDetectionInstruction(learnerId, addressByName);

  const result = await callJSON(fullSystem, messages);
  console.log(`\n--- ${label} ---`);
  console.log("has_issue:", result.has_issue);
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

  // --- 민지: enthusiastic/slangy fragment answering a destination question
  // (mirrors the target example almost exactly) — react to energy first.
  const minjiMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "What terminal are you at?" },
    { role: "user", content: "here ㅋㅋ" },
  ];
  const m1 = await detect("민지 (A2) — enthusiastic fragment, addressByName=true", "A2", "민지", true, empty(), emptyChecklist, minjiMsgs);
  minjiMsgs.push({ role: "assistant", content: `[튜터]: ${m1.tutor_line}` });
  minjiMsgs.push({ role: "assistant", content: "London it is! Do you have any bags to check in?" });
  minjiMsgs.push({ role: "user", content: "I have one bag and I am go with my sister too." });

  // --- 민지 continued: grammar mistake, same session, no name this turn —
  // checks turn-to-turn variety in both reaction and nudge.
  await detect("민지 (A2) — grammar, addressByName=false, next turn", "A2", "민지", false, empty(), emptyChecklist, minjiMsgs);

  // --- 지훈: matched pattern count 2 then count 3 (tier 2-3).
  const droppedAux = { pattern: "dropping the auxiliary verb in questions/statements (e.g. 'I go' instead of 'I'm going')", count: 2 };
  const jihoonProfile2 = {
    learner_id: "지훈",
    level: "B1",
    weak_expressions: [droppedAux],
    style_patterns: [],
    last_studied_at: null,
    last_session_summary: null,
  };
  const jihoonContext2: RetrievedContext = {
    mistakes: [{ id: "m1", text: droppedAux.pattern, metadata: { type: "user_mistake" }, score: 0.9 }],
    utterances: [],
    knowledge: [],
    learnerProfile: jihoonProfile2,
  };
  const jihoonMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "Where are you headed today?" },
    { role: "user", content: "I go to Paris for vacation." },
  ];
  const j1 = await detect(
    "지훈 (B1) — grammar, seen 2x before (tier 2-3), addressByName=true",
    "B1",
    "지훈",
    true,
    jihoonContext2,
    emptyChecklist,
    jihoonMsgs,
  );
  jihoonMsgs.push({ role: "assistant", content: `[튜터]: ${j1.tutor_line}` });
  jihoonMsgs.push({ role: "assistant", content: "Nice! And how many bags are you checking in today?" });
  jihoonMsgs.push({ role: "user", content: "I have two bag, one is go over the weight limit I think." });

  const jihoonProfile3 = { ...jihoonProfile2, weak_expressions: [{ ...droppedAux, count: 3 }] };
  const jihoonContext3: RetrievedContext = { ...jihoonContext2, learnerProfile: jihoonProfile3 };
  await detect(
    "지훈 (B1) — grammar, seen 3x before (tier 2-3), addressByName=false, next turn",
    "B1",
    "지훈",
    false,
    jihoonContext3,
    emptyChecklist,
    jihoonMsgs,
  );

  // --- 현우: matched pattern count 5 (tier 4+), with name-address, plus a
  // paired style_pattern_note.
  const stronglyRecurring = { pattern: "using 'want' instead of a more polite indirect request form", count: 5 };
  const overusedGet = { pattern: "overusing the verb 'get' instead of more precise/polite alternatives", count: 3 };
  const hyunwooProfile = {
    learner_id: "현우",
    level: "B2",
    weak_expressions: [stronglyRecurring],
    style_patterns: [overusedGet],
    last_studied_at: null,
    last_session_summary: null,
  };
  const hyunwooContext: RetrievedContext = {
    mistakes: [{ id: "m2", text: stronglyRecurring.pattern, metadata: { type: "user_mistake" }, score: 0.9 }],
    utterances: [],
    knowledge: [],
    learnerProfile: hyunwooProfile,
  };
  const hyunwooMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "What can I help you with today?" },
    { role: "user", content: "I want a window seat and I want extra legroom too, can you get that for me." },
  ];
  await detect(
    "현우 (B2) — grammar, seen 5x before (tier 4+), addressByName=true",
    "B2",
    "현우",
    true,
    hyunwooContext,
    emptyChecklist,
    hyunwooMsgs,
  );

  // --- Rude/blunt phrasing — checks the softened "무례하게 들릴 수도 있어"
  // framing instead of any "that's wrong" language.
  const bluntMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "Sure, I can help — what would you like?" },
    { role: "user", content: "Give me window seat now, I don't want to wait." },
  ];
  await detect("Mike (B2) — blunt/rude phrasing, addressByName=false", "B2", "Mike", false, empty(), emptyChecklist, bluntMsgs);

  // --- 수아: bare fragment (plain, low-energy) — baseline reaction+nudge
  // without forced enthusiasm.
  const suaMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "What's inside the bag that pushed it over the weight limit?" },
    { role: "user", content: "stuff" },
  ];
  await detect("수아 (A2) — bare fragment (plain), addressByName=false", "A2", "수아", false, empty(), emptyChecklist, suaMsgs);

  // --- 수아 continued: pending situation item glossed over, with name.
  const situationChecklist: MissionChecklistItem[] = [
    { id: "find_passport", description_ko: "여권을 찾는 데 시간이 걸리는 상황을 설명하기", type: "situation", done: false },
  ];
  const suaMsgs2: Anthropic.MessageParam[] = [
    { role: "assistant", content: "Could I see your passport, please?" },
    { role: "user", content: "um, one second" },
    { role: "assistant", content: "Take your time." },
    { role: "user", content: "here you go" },
  ];
  await detect(
    "수아 (A2) — pending situation item glossed over, addressByName=true",
    "A2",
    "수아",
    true,
    empty(),
    situationChecklist,
    suaMsgs2,
  );

  // --- Style pattern habit "get", count 2 then count 4 — checks the
  // warm/playful callout tone (not a verdict) and its tier progression.
  const overusedGet2 = { pattern: "overusing the verb 'get' instead of more precise/polite alternatives", count: 2 };
  const styleProfile2 = {
    learner_id: "지훈",
    level: "B1",
    weak_expressions: [],
    style_patterns: [overusedGet2],
    last_studied_at: null,
    last_session_summary: null,
  };
  const styleContext2: RetrievedContext = { mistakes: [], utterances: [], knowledge: [], learnerProfile: styleProfile2 };
  const styleMsgs: Anthropic.MessageParam[] = [
    { role: "assistant", content: "Sure, what would you like to order?" },
    { role: "user", content: "Can I get a coffee, please?" },
  ];
  await detect("지훈 (B1) — style pattern 'get', count 2", "B1", "지훈", false, styleContext2, emptyChecklist, styleMsgs);

  const styleProfile4 = { ...styleProfile2, style_patterns: [{ ...overusedGet2, count: 4 }] };
  const styleContext4: RetrievedContext = { ...styleContext2, learnerProfile: styleProfile4 };
  const styleMsgs2: Anthropic.MessageParam[] = [
    { role: "assistant", content: "Anything else for you?" },
    { role: "user", content: "Can I get the check too?" },
  ];
  await detect("지훈 (B1) — style pattern 'get', count 4", "B1", "지훈", false, styleContext4, emptyChecklist, styleMsgs2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

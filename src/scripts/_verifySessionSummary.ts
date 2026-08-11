import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { buildSessionReportPrompt, type MissionChecklistItem } from "../lib/prompts.js";
import type { PatternEntry } from "../lib/memory.js";

const client = new Anthropic();

async function callJSONOnce(systemPrompt: string): Promise<any> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: "Write the report now." }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("no text block");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
  return JSON.parse(cleaned);
}

async function run(
  label: string,
  checklist: MissionChecklistItem[],
  corrections: { wrong: string; fixed: string }[],
  existingWeakExpressions: PatternEntry[],
  existingStylePatterns: PatternEntry[],
) {
  const systemPrompt = buildSessionReportPrompt(checklist, corrections, existingWeakExpressions, existingStylePatterns);
  const result = await callJSONOnce(systemPrompt);

  console.log(`\n=== ${label} ===`);
  console.log(`오늘 총평: ${result.today_summary}`);
  console.log(`다음 목표: ${result.next_goal}`);
  console.log("(focus_suggestions for comparison):", result.focus_suggestions);
}

async function main() {
  // --- Session A: mostly smooth, one recurring grammar slip that matches a
  // previously recorded weak_expression (count 2 → this session makes it 3rd).
  await run(
    "A — mostly smooth, one recurring slip",
    [
      { id: "destination", description_ko: "목적지 말하기", type: "fact", done: true },
      { id: "bags", description_ko: "수하물 개수 말하기", type: "fact", done: true },
      { id: "seat", description_ko: "좌석 선호 말하기", type: "fact", done: true },
    ],
    [{ wrong: "I go to Paris for vacation.", fixed: "I'm going to Paris for vacation." }],
    [{ pattern: "dropping the auxiliary verb in questions/statements (e.g. 'I go' instead of 'I'm going')", count: 2 }],
    [],
  );

  // --- Session B: rougher session, several different corrections, one
  // checklist item missed, an existing style habit ("get") on record.
  await run(
    "B — rougher session, missed checklist item",
    [
      { id: "destination", description_ko: "목적지 말하기", type: "fact", done: true },
      { id: "bags", description_ko: "수하물 개수 말하기", type: "fact", done: true },
      { id: "overweight_bag", description_ko: "수하물이 무게 초과인 상황 설명하기", type: "situation", done: false },
    ],
    [
      { wrong: "I have two bag.", fixed: "I have two bags." },
      { wrong: "Can I get window seat?", fixed: "Could I get a window seat, please?" },
      { wrong: "This bag is too much heavy.", fixed: "This bag is too heavy." },
    ],
    [],
    [{ pattern: "overusing the verb 'get' instead of more precise/polite alternatives", count: 3 }],
  );

  // --- Session C: clean session, zero corrections, but one checklist item
  // missed — next_goal has nothing from THIS session, must pull from history.
  await run(
    "C — clean session, no fresh corrections, one item missed",
    [
      { id: "destination", description_ko: "목적지 말하기", type: "fact", done: true },
      { id: "seat", description_ko: "좌석 선호 말하기", type: "fact", done: true },
      { id: "vegetarian_meal", description_ko: "기내식으로 채식 요청하기", type: "fact", done: false },
    ],
    [],
    [{ pattern: "using 'want' instead of a more polite indirect request form", count: 4 }],
    [],
  );

  // --- Session D: brand-new learner, no history at all, but this session
  // had corrections — next_goal must draw from THIS session's own corrections.
  await run(
    "D — brand-new learner, no history, this session's own corrections",
    [
      { id: "destination", description_ko: "목적지 말하기", type: "fact", done: true },
      { id: "bags", description_ko: "수하물 개수 말하기", type: "fact", done: false },
    ],
    [
      { wrong: "here", fixed: "Here you go, one moment please." },
      { wrong: "You bring me the menu?", fixed: "Could you bring me the menu?" },
    ],
    [],
    [],
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

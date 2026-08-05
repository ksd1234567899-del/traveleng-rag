import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildMissionChecklistBlock,
  buildOpeningInstruction,
  buildRetrievedContextBlock,
  buildStaffDialogueInstruction,
  buildSystemPrompt,
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

const FORCED_ELEMENTS = ["overweight or oversized baggage"];

// Identical across both levels on purpose — isolates level as the only
// variable driving any difference in Staff's output.
const SCRIPTED_LEARNER_TURNS = [
  "Here's my passport and booking reference.",
  "I have one suitcase to check in.",
  "Oh okay — what can I do about that?",
  "I'd like a window seat, please.",
];

const emptyContext: RetrievedContext = { mistakes: [], utterances: [], knowledge: [], learnerProfile: null };

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

// Same retry-once idiom as chat.ts's request* helpers.
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

async function runLevel(level: string) {
  console.log(`\n\n########## LEVEL ${level} ##########`);

  const systemPrompt = buildSystemPrompt(scenario, level);

  // --- Opening turn ---
  const openingSystemPrompt =
    systemPrompt + "\n\n" + buildRetrievedContextBlock(emptyContext) + "\n\n" + buildOpeningInstruction(level, FORCED_ELEMENTS, scenario.missionBasics);
  const opening = await callJSON(openingSystemPrompt, [{ role: "user", content: "[SESSION START]" }]);

  const checklist: MissionChecklistItem[] = (opening.mission_checklist ?? []).map((item: any) => ({
    ...item,
    done: false,
  }));

  console.log("\n[미션]:", opening.mission_briefing);
  console.log("Staff:", opening.staff_line);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "[SESSION START]" },
    { role: "assistant", content: `${opening.mission_briefing}\n\n${opening.staff_line}` },
  ];

  // --- Follow-up turns ---
  for (const learnerLine of SCRIPTED_LEARNER_TURNS) {
    messages.push({ role: "user", content: learnerLine });

    const checklistBlock = buildMissionChecklistBlock(checklist);
    const staffSystemPrompt =
      systemPrompt + "\n\n" + buildRetrievedContextBlock(emptyContext) + "\n\n" + checklistBlock + "\n\n" + buildStaffDialogueInstruction(scenario.completionExample);

    const staffResp = await callJSON(staffSystemPrompt, messages);
    console.log(`\nYou: ${learnerLine}`);
    console.log("Staff:", staffResp.staff_line);

    messages.push({ role: "assistant", content: staffResp.staff_line });
  }
}

async function main() {
  await runLevel("A2");
  await runLevel("B2");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

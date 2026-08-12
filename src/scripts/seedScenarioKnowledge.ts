import "dotenv/config";
import { addDocument, listDocuments, type VectorDoc } from "../lib/vectorstore.js";

// Non-destructive counterpart to seed.ts — that script resets the whole
// vector index and adds demo user_001 mistake/utterance data, which is fine
// for a fresh local dev index but unsafe against production, where real
// participant embeddings already exist (reset would wipe them). This only
// ever adds scenario_knowledge reference docs, never touches existing
// user_mistake/user_utterance data, and is idempotent: skips entirely if any
// scenario_knowledge docs already exist, so re-running it can't duplicate
// entries.
const docs: VectorDoc[] = [
  // airport
  {
    id: "know_airport_1",
    text: "When checking in, travelers often say 'I have my luggage here' — remind them that 'luggage' is uncountable, so we say 'a piece of luggage' or 'bags,' not 'a luggage.'",
    metadata: { type: "scenario_knowledge", scenario: "airport", level: "B1" },
  },
  {
    id: "know_airport_2",
    text: "A polite way to ask about seating is 'Could I get a window seat, please?' rather than 'Give me window seat.'",
    metadata: { type: "scenario_knowledge", scenario: "airport", level: "B1" },
  },
  // restaurant
  {
    id: "know_restaurant_1",
    text: "When ordering, natural phrasing is 'I'll have the...' or 'Could I get the...' rather than 'I want.'",
    metadata: { type: "scenario_knowledge", scenario: "restaurant", level: "B1" },
  },
  {
    id: "know_restaurant_2",
    text: "Waitstaff often ask 'Are you ready to order?' — a natural learner reply is 'Yes, I'll have...' or 'Could we have a few more minutes?'",
    metadata: { type: "scenario_knowledge", scenario: "restaurant", level: "B1" },
  },
  // hotel
  {
    id: "know_hotel_1",
    text: "When checking in, a natural way to confirm a reservation is 'I have a reservation under the name...' rather than 'I book a room.'",
    metadata: { type: "scenario_knowledge", scenario: "hotel", level: "B1" },
  },
  {
    id: "know_hotel_2",
    text: "To ask about a later check-out politely: 'Could I get a late check-out, if possible?' rather than 'I want late check-out.'",
    metadata: { type: "scenario_knowledge", scenario: "hotel", level: "B1" },
  },
  // taxi
  {
    id: "know_taxi_1",
    text: "A natural way to state a destination is 'Could you take me to...?' or 'I'm heading to...' rather than 'I want go to...'",
    metadata: { type: "scenario_knowledge", scenario: "taxi", level: "B1" },
  },
  {
    id: "know_taxi_2",
    text: "To ask about the fare naturally: 'About how much will it cost to get there?' rather than 'How much money?'",
    metadata: { type: "scenario_knowledge", scenario: "taxi", level: "B1" },
  },
  // tourist_info
  {
    id: "know_tourist_info_1",
    text: "A natural way to ask for a recommendation is 'Could you recommend a good place for...?' rather than 'Tell me good place.'",
    metadata: { type: "scenario_knowledge", scenario: "tourist_info", level: "B1" },
  },
  {
    id: "know_tourist_info_2",
    text: "When asking for directions, a natural phrase is 'Could you tell me how to get there?' or 'Is it within walking distance?' rather than 'Where is it, tell me way.'",
    metadata: { type: "scenario_knowledge", scenario: "tourist_info", level: "B1" },
  },
];

async function main() {
  const existing = await listDocuments({ type: "scenario_knowledge" });
  if (existing.length > 0) {
    console.log(`Found ${existing.length} existing scenario_knowledge doc(s) — skipping to avoid duplicates.`);
    console.log(existing.map((d) => `  [${d.metadata.scenario}] ${d.id}`).join("\n"));
    return;
  }

  for (const doc of docs) {
    await addDocument(doc);
    console.log(`Inserted [${doc.metadata.scenario}] ${doc.id}`);
  }

  console.log(`\nSeeded ${docs.length} scenario_knowledge documents across ${new Set(docs.map((d) => d.metadata.scenario)).size} scenarios.`);
}

main().catch((error) => {
  console.error("Seed script failed:", error);
  process.exitCode = 1;
});

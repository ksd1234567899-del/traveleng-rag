import "dotenv/config";
import { addDocument, resetIndex } from "../lib/vectorstore.js";

const LEARNER_ID = "user_001";

interface SeedDoc {
  id: string;
  text: string;
  metadata: Parameters<typeof addDocument>[0]["metadata"];
}

const docs: SeedDoc[] = [
  // scenario_knowledge — airport
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
  // scenario_knowledge — restaurant
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
  // scenario_knowledge — hotel
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
  // scenario_knowledge — taxi
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
  // scenario_knowledge — tourist_info
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
  // user_mistake — user_001, airport
  {
    id: "mistake_user_001_1",
    text: "Dropped-auxiliary-verb pattern: said 'I have book it yesterday' instead of 'I booked it yesterday' or 'I had booked it.'",
    metadata: {
      type: "user_mistake",
      learner_id: LEARNER_ID,
      scenario: "airport",
      date: "2026-07-20T00:00:00.000Z",
    },
  },
  {
    id: "mistake_user_001_2",
    text: "Missing article: said 'is that correct way' instead of 'is that the correct way' or 'is that right?'",
    metadata: {
      type: "user_mistake",
      learner_id: LEARNER_ID,
      scenario: "airport",
      date: "2026-07-20T00:00:00.000Z",
    },
  },
  {
    id: "mistake_user_001_3",
    text: "Misspelled 'luggage' as 'laguage' while checking in.",
    metadata: {
      type: "user_mistake",
      learner_id: LEARNER_ID,
      scenario: "airport",
      date: "2026-07-20T00:00:00.000Z",
    },
  },
  // user_utterance — user_001, airport
  {
    id: "utterance_user_001_1",
    text: "Hello, I want to check in for my flight. I have book it yesterday.",
    metadata: { type: "user_utterance", learner_id: LEARNER_ID, scenario: "airport" },
  },
  {
    id: "utterance_user_001_2",
    text: "Yes, one suitcase please.",
    metadata: { type: "user_utterance", learner_id: LEARNER_ID, scenario: "airport" },
  },
  {
    id: "utterance_user_001_3",
    text: "Window seat please, thank you.",
    metadata: { type: "user_utterance", learner_id: LEARNER_ID, scenario: "airport" },
  },
];

async function main() {
  console.log("Resetting vector index...");
  await resetIndex();

  for (const doc of docs) {
    await addDocument(doc);
    console.log(`Inserted [${doc.metadata.type}] ${doc.id}`);
  }

  console.log(`\nSeeded ${docs.length} documents.`);
}

main().catch((error) => {
  console.error("Seed script failed:", error);
  process.exitCode = 1;
});

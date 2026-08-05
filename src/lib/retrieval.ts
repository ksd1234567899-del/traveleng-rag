import { debugLog } from "./debugLog.js";
import { getOrCreateLearner, type LearnerProfile } from "./memory.js";
import { queryDocuments, type RetrievedDoc } from "./vectorstore.js";

export interface RetrievedContext {
  mistakes: RetrievedDoc[];
  utterances: RetrievedDoc[];
  knowledge: RetrievedDoc[];
  learnerProfile: LearnerProfile | null;
}

interface RetrieveContextParams {
  learnerId: string;
  scenario: string;
  userMessage: string;
}

const TOKEN_BUDGET = 600;

// Rough token estimate for a soft context budget — not a billing-accurate count.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function docsTokens(docs: RetrievedDoc[]): number {
  return docs.reduce((sum, d) => sum + estimateTokens(d.text), 0);
}

interface RetrievedDocs {
  mistakes: RetrievedDoc[];
  utterances: RetrievedDoc[];
  knowledge: RetrievedDoc[];
}

// Priority order: mistakes > utterances > knowledge. Drop from the lowest
// priority array first (knowledge, then utterances, then mistakes) until
// the total is under budget.
function applyTokenBudget(docs: RetrievedDocs, budget: number): RetrievedDocs {
  const mistakes = [...docs.mistakes];
  const utterances = [...docs.utterances];
  const knowledge = [...docs.knowledge];

  const total = () => docsTokens(mistakes) + docsTokens(utterances) + docsTokens(knowledge);

  while (total() > budget && knowledge.length > 0) {
    knowledge.pop();
  }
  while (total() > budget && utterances.length > 0) {
    utterances.pop();
  }
  while (total() > budget && mistakes.length > 0) {
    mistakes.pop();
  }

  return { mistakes, utterances, knowledge };
}

// Re-ranks similarity-ranked mistake candidates so patterns the learner has
// struggled with more persistently (higher count in weak_expressions) are
// prioritized over merely-more-similar ones, using similarity only as a
// tiebreak. Doc text matches a weak_expressions pattern exactly (vector docs
// are written with that same verbatim text — see saveSessionVectorDocs).
function prioritizeByFrequency(docs: RetrievedDoc[], learnerProfile: LearnerProfile | null): RetrievedDoc[] {
  const countFor = (text: string): number =>
    learnerProfile?.weak_expressions.find((e) => e.pattern === text)?.count ?? 1;

  return [...docs].sort((a, b) => {
    const countDiff = countFor(b.text) - countFor(a.text);
    return countDiff !== 0 ? countDiff : b.score - a.score;
  });
}

export async function retrieveContext({
  learnerId,
  scenario,
  userMessage,
}: RetrieveContextParams): Promise<RetrievedContext> {
  // 1. Load learner profile (used for weak_expressions/style_patterns
  // frequency data below; a DB hiccup here must not break retrieval for
  // the turn).
  let learnerProfile: LearnerProfile | null = null;
  try {
    learnerProfile = getOrCreateLearner(learnerId);
  } catch (error) {
    console.warn("Failed to load learner profile during retrieval, continuing:", error);
  }

  // 2. Filter for scenario_knowledge docs belonging to the current scenario.
  const scenarioKnowledgeFilter = { type: "scenario_knowledge", scenario };

  // 3. Search user_mistake docs, filtered by learner, ranked by similarity.
  // Fetch a wider candidate pool than we'll actually use, so patterns the
  // learner has struggled with more persistently can be prioritized over
  // merely-more-similar-to-this-message ones before trimming back down.
  const mistakeCandidates = await queryDocuments({
    queryText: userMessage,
    filter: { type: "user_mistake", learner_id: learnerId },
    topK: 6,
  });
  const mistakes = prioritizeByFrequency(mistakeCandidates, learnerProfile).slice(0, 3);

  // 4. Search user_utterance docs, filtered by learner, ranked by similarity.
  const utterances = await queryDocuments({
    queryText: userMessage,
    filter: { type: "user_utterance", learner_id: learnerId },
    topK: 2,
  });

  // 5. Search scenario_knowledge docs using the step-2 filter, ranked by similarity.
  const knowledge = await queryDocuments({
    queryText: userMessage,
    filter: scenarioKnowledgeFilter,
    topK: 2,
  });

  // TEMPORARY DEBUG — written to logs/debug/ instead of the console so the
  // terminal stays clean during live testing.
  const logDocs = (label: string, docs: RetrievedDoc[]) =>
    debugLog(
      learnerId,
      `[retrieval debug] ${label} (learner_id=${learnerId}):`,
      docs.length === 0 ? "(none)" : docs.map((d) => ({ id: d.id, text: d.text })),
    );
  debugLog(learnerId, `\n[retrieval debug] --- turn for learner_id=${learnerId}, scenario=${scenario} ---`);
  logDocs("user_mistake", mistakes);
  logDocs("user_utterance", utterances);
  logDocs("scenario_knowledge", knowledge);

  // 6. Merge and trim to a rough token budget.
  const trimmed = applyTokenBudget({ mistakes, utterances, knowledge }, TOKEN_BUDGET);
  return { ...trimmed, learnerProfile };
}

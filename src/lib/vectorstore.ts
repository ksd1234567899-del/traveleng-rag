import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import OpenAI from "openai";
import { LocalIndex, type MetadataFilter, type MetadataTypes } from "vectra";
import { getVectorstoreDir } from "./paths.js";

export type DocType = "scenario_knowledge" | "user_mistake" | "user_utterance";

export interface VectorDocMetadata {
  type: DocType;
  scenario?: string;
  level?: string;
  learner_id?: string;
  date?: string;
}

export interface VectorDoc {
  id: string;
  text: string;
  metadata: VectorDocMetadata;
}

export interface RetrievedDoc extends VectorDoc {
  score: number;
}

const EMBEDDING_MODEL = "text-embedding-3-small";

const indexPath = getVectorstoreDir();
mkdirSync(dirname(indexPath), { recursive: true });

const openai = new OpenAI();
const index = new LocalIndex(indexPath);

async function ensureIndex(): Promise<void> {
  if (!(await index.isIndexCreated())) {
    await index.createIndex();
  }
}

async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

// vectra metadata values must be primitives — strip undefined entries rather
// than storing them.
function cleanMetadata(metadata: Record<string, unknown>): Record<string, MetadataTypes> {
  const cleaned: Record<string, MetadataTypes> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      cleaned[key] = value as MetadataTypes;
    }
  }
  return cleaned;
}

export async function addDocument(doc: VectorDoc): Promise<void> {
  await ensureIndex();
  const vector = await embed(doc.text);
  await index.insertItem({
    vector,
    metadata: cleanMetadata({ ...doc.metadata, text: doc.text, doc_id: doc.id }),
  });
}

interface QueryOptions {
  queryText: string;
  filter: MetadataFilter;
  topK: number;
}

export async function queryDocuments({ queryText, filter, topK }: QueryOptions): Promise<RetrievedDoc[]> {
  try {
    await ensureIndex();
    const vector = await embed(queryText);
    const results = await index.queryItems(vector, queryText, topK, filter);

    return results.map((result) => {
      const metadata = result.item.metadata as unknown as VectorDocMetadata & { text: string; doc_id: string };
      return {
        id: metadata.doc_id,
        text: metadata.text,
        metadata: {
          type: metadata.type,
          scenario: metadata.scenario,
          level: metadata.level,
          learner_id: metadata.learner_id,
          date: metadata.date,
        },
        score: result.score,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Vector query failed for filter ${JSON.stringify(filter)}, continuing without it: ${message}`);
    return [];
  }
}

export async function listDocuments(filter: MetadataFilter): Promise<VectorDoc[]> {
  await ensureIndex();
  const items = await index.listItemsByMetadata(filter);

  return items.map((item) => {
    const metadata = item.metadata as unknown as VectorDocMetadata & { text: string; doc_id: string };
    return {
      id: metadata.doc_id,
      text: metadata.text,
      metadata: {
        type: metadata.type,
        scenario: metadata.scenario,
        level: metadata.level,
        learner_id: metadata.learner_id,
        date: metadata.date,
      },
    };
  });
}

export async function resetIndex(): Promise<void> {
  if (await index.isIndexCreated()) {
    await index.deleteIndex();
  }
  await index.createIndex();
}

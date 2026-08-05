import "dotenv/config";
import { listDocuments } from "../lib/vectorstore.js";

function parseArgs(): { learnerId: string } {
  const params: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (match) params[match[1]] = match[2];
  }

  if (!params.learner) {
    console.error("Usage: npm run inspect -- --learner=<learner_id>");
    process.exit(1);
  }

  return { learnerId: params.learner };
}

const { learnerId } = parseArgs();

const docs = await listDocuments({ learner_id: learnerId });

if (docs.length === 0) {
  console.log(`No vector documents found for learner_id="${learnerId}".`);
} else {
  console.log(`Found ${docs.length} document(s) for learner_id="${learnerId}":\n`);
  for (const doc of docs) {
    console.log(`- [${doc.metadata.type}] ${doc.id}`);
    console.log(`  scenario: ${doc.metadata.scenario ?? "(none)"}`);
    console.log(`  text: ${doc.text}`);
    console.log();
  }
}

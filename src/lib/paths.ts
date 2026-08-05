import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/lib -> src -> project root
const projectRoot = join(__dirname, "..", "..");

// When DATA_DIR is set (e.g. a mounted persistent volume in deployment), all
// SQLite/vectorstore/log storage moves under it, in the same relative layout
// as the project-root default below — so unset DATA_DIR (local dev, the CLI)
// reproduces today's exact paths with zero behavior change.
const dataRoot = process.env.DATA_DIR ?? projectRoot;

export function getDbPath(): string {
  return join(dataRoot, "src", "db", "learners.sqlite");
}

export function getVectorstoreDir(): string {
  return join(dataRoot, "src", "db", "vectorstore");
}

export function getParticipantsDir(): string {
  return join(dataRoot, "logs", "participants");
}

export function getDebugDir(): string {
  return join(dataRoot, "logs", "debug");
}

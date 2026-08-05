import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { getDebugDir } from "./paths.js";

const debugDir = getDebugDir();

// Keyed per learner rather than a single cached path — a CLI run only ever
// has one learnerId per process, but the HTTP server holds many concurrent
// sessions in one process, and each learner's debug trace must land in its
// own file rather than all piling into whichever learner happened to log
// first.
const debugFilePaths = new Map<string, string>();

function getDebugFilePath(learnerId: string): string {
  let path = debugFilePaths.get(learnerId);
  if (!path) {
    mkdirSync(debugDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    path = join(debugDir, `${learnerId}-${timestamp}.log`);
    debugFilePaths.set(learnerId, path);
  }
  return path;
}

// Same args shape as console.log — uses util.format internally (what
// console.log itself uses) so the on-disk text matches exactly what would
// have been printed to the terminal.
export function debugLog(learnerId: string, ...args: unknown[]): void {
  try {
    const path = getDebugFilePath(learnerId);
    appendFileSync(path, format(...args) + "\n", "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to write debug log, continuing: ${message}`);
  }
}

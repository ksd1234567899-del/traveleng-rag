import Anthropic from "@anthropic-ai/sdk";

export const MAX_REQUEST_ATTEMPTS = 3; // 1 initial + 2 retries
export const RETRY_BACKOFF_MS = 800;
export const REFORMAT_NUDGE =
  "Your previous reply was not valid JSON. Respond again with ONLY the raw JSON object described above — no markdown fences, no commentary, nothing else.";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withReformatNudge(baseMessages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return [...baseMessages, { role: "user", content: REFORMAT_NUDGE }];
}

// An Anthropic APIError with status undefined (network-level) or >=500/429 is
// a transient server-side issue worth a delayed retry on the *same* request —
// as opposed to a JSON parse/shape error (our own validation), which is
// retried immediately with the reformat nudge since nothing was wrong with
// the round-trip itself.
export function isRetryableApiError(error: unknown): boolean {
  return error instanceof Anthropic.APIError && (error.status === undefined || error.status >= 500 || error.status === 429);
}

// Shared retry loop for every request*Once helper below. `attempt` receives
// whether this call should include the reformat nudge (decided by what kind
// of error the previous attempt hit) and performs the actual API call plus
// parsing/validation; `fallback` runs only once, after every attempt is
// exhausted, and must never throw.
export async function requestWithRetry<T>(
  label: string,
  attempt: (includeReformatNudge: boolean) => Promise<T>,
  fallback: (lastError: unknown) => T,
): Promise<T> {
  let lastError: unknown;
  let includeReformatNudge = false;

  for (let attemptNumber = 1; attemptNumber <= MAX_REQUEST_ATTEMPTS; attemptNumber++) {
    try {
      return await attempt(includeReformatNudge);
    } catch (error) {
      lastError = error;
      if (attemptNumber === MAX_REQUEST_ATTEMPTS) break;

      const message = error instanceof Error ? error.message : String(error);
      if (isRetryableApiError(error)) {
        console.warn(`${label} request failed (attempt ${attemptNumber}/${MAX_REQUEST_ATTEMPTS}), retrying after backoff: ${message}`);
        await sleep(RETRY_BACKOFF_MS);
        includeReformatNudge = false;
      } else {
        console.warn(`${label} response was invalid (attempt ${attemptNumber}/${MAX_REQUEST_ATTEMPTS}), retrying: ${message}`);
        includeReformatNudge = true;
      }
    }
  }

  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(`${label} failed after ${MAX_REQUEST_ATTEMPTS} attempts, using fallback: ${finalMessage}`);
  return fallback(lastError);
}

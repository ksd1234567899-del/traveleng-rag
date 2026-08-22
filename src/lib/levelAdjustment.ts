// Tuned from live dev_1 testing (5 sessions, correction rates 0.20-1.00) plus
// a clean post-fix session (0.0, confirming 0.2 is reachable for genuinely
// correct output once the fragment/handoff false-positive bugs were fixed —
// the old rates were inflated by those bugs, not by the threshold itself).
// Nudged slightly looser than the original 0.2/0.5 so a single stray mistake
// in a short session doesn't block leveling up, and demotion has a bit more
// tolerance before firing.
export const MIN_TURNS_FOR_LEVEL_ADJUSTMENT = 4; // below this, sample too small — skip
export const RAISE_LEVEL_THRESHOLD = 0.4; // < 40% of turns needed correction -> raise one tier
export const LOWER_LEVEL_THRESHOLD = 0.6; // > 60% of turns needed correction -> lower one tier
export const LEVELS = ["A2", "B1", "B2"];

// Unvalidated starting values (unlike the two thresholds above, these have no
// live session data behind them yet) — a fluency gate on top of
// correctionRate, added because correctionRate alone rewards minimal, safe,
// error-free fragments over ambitious-but-imperfect attempts at natural
// phrasing, which runs directly against this system's stated goal (see
// GUIDING_PRINCIPLE in prompts.ts). The raise-gate (0.6) is deliberately
// HIGHER than the lower-leniency-gate (0.4): a false raise is the costlier
// mistake (pushes the learner into harder content prematurely, and this
// recomputes every session), so earning one should demand more evidence of
// genuine complexity attempts than merely avoiding a lower requires.
export const COMPLEX_RAISE_THRESHOLD = 0.5; // raise requires >= 50% of turns attempting complex phrasing
export const COMPLEX_LOWER_LENIENCY_THRESHOLD = 0.4; // >= 40% attempt rate earns leniency from lowering
export const LOWER_LEVEL_HARD_THRESHOLD = 0.8; // above this, lower regardless of complexity attempts — too broken to excuse

export function computeLevelAdjustment(
  level: string,
  correctionCount: number,
  turnCount: number,
  complexAttemptCount: number,
  // Denominator for complexRate — turns where attempting complex phrasing was
  // actually a contextually reasonable option (see complex_phrasing_eligible
  // in prompts.ts), NOT turnCount. A session with several closed yes/no
  // exchanges shouldn't have complexRate diluted by turns where ambitious
  // phrasing was never on the table to begin with — correctionRate still
  // uses turnCount (a legitimate short answer never gets flagged as a
  // mistake, so it only ever helps correctionRate, never needs excluding).
  complexEligibleTurnCount: number,
): { newLevel: string; reason: string } {
  if (turnCount < MIN_TURNS_FOR_LEVEL_ADJUSTMENT) {
    return {
      newLevel: level,
      reason: `only ${turnCount} normal turns this session (< ${MIN_TURNS_FOR_LEVEL_ADJUSTMENT}), skipping adjustment`,
    };
  }

  const rate = correctionCount / turnCount;
  const complexRate = complexEligibleTurnCount > 0 ? complexAttemptCount / complexEligibleTurnCount : 0;
  const idx = LEVELS.indexOf(level);
  const rateStr = `correction rate ${rate.toFixed(2)}, complex-phrasing attempt rate ${complexRate.toFixed(2)} (${complexAttemptCount}/${complexEligibleTurnCount} complex-eligible turns)`;

  if (rate < RAISE_LEVEL_THRESHOLD && complexRate >= COMPLEX_RAISE_THRESHOLD && idx < LEVELS.length - 1) {
    const newLevel = LEVELS[idx + 1];
    return { newLevel, reason: `${rateStr} — below ${RAISE_LEVEL_THRESHOLD} and above ${COMPLEX_RAISE_THRESHOLD}, raising ${level} -> ${newLevel}` };
  }
  if (rate > LOWER_LEVEL_HARD_THRESHOLD && idx > 0) {
    const newLevel = LEVELS[idx - 1];
    return { newLevel, reason: `${rateStr} — correction rate above ${LOWER_LEVEL_HARD_THRESHOLD}, lowering ${level} -> ${newLevel} regardless of complexity attempts` };
  }
  if (rate > LOWER_LEVEL_THRESHOLD && complexRate < COMPLEX_LOWER_LENIENCY_THRESHOLD && idx > 0) {
    const newLevel = LEVELS[idx - 1];
    return { newLevel, reason: `${rateStr} — above ${LOWER_LEVEL_THRESHOLD} and below ${COMPLEX_LOWER_LENIENCY_THRESHOLD}, lowering ${level} -> ${newLevel}` };
  }
  if (rate > LOWER_LEVEL_THRESHOLD && complexRate >= COMPLEX_LOWER_LENIENCY_THRESHOLD) {
    return { newLevel: level, reason: `${rateStr} — correction rate elevated but complex-phrasing attempts earn leniency, keeping ${level}` };
  }
  if (rate < RAISE_LEVEL_THRESHOLD && complexRate < COMPLEX_RAISE_THRESHOLD) {
    return { newLevel: level, reason: `${rateStr} — correction rate low but phrasing stayed too minimal to justify a raise, keeping ${level}` };
  }
  return { newLevel: level, reason: `${rateStr} — within normal range, keeping ${level}` };
}

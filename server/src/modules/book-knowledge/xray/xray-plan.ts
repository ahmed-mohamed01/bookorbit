import type { BookKnowledgeXrayEstimate, BookKnowledgeXrayStepId } from '@bookorbit/types';

/** Rough characters per prompt token for gpt-oss on English prose and these prompts. */
export const CHARS_PER_TOKEN = 3.4;
/**
 * Mean output tokens per call (reasoning included) on gpt-oss-20b at low effort; the dense figures are guesses until a run measures them.
 * `about` and `describe` allow for the tiered aims: about 50 words for the main cast, 30 for supporting, 100 at most.
 */
const OUTPUT_PER_CALL: Partial<Record<BookKnowledgeXrayStepId, number>> = {
  kinds: 193,
  ties: 474,
  about: 800,
  notes: 900,
  facts: 700,
  now: 300,
  alias: 900,
  describe: 1000,
};
/** The handoff's measured local rate: 855k tokens in 57.6 minutes (upstream on gpt-oss-20b, M5 Pro). */
const TOKENS_PER_MINUTE = 855_000 / 57.6;
/** The same run split by kind of token: prompt about 1,000 and output about 66 tokens a second. */
const PROMPT_TOKENS_PER_SECOND = 1000;
const OUTPUT_TOKENS_PER_SECOND = 66;

export interface PlannedCall {
  step: BookKnowledgeXrayStepId;
  promptCharacters: number;
}

/** Calls, tokens and minutes for planned calls, without sending anything. */
export function estimate(calls: readonly PlannedCall[]): BookKnowledgeXrayEstimate {
  const steps = new Map<BookKnowledgeXrayStepId, BookKnowledgeXrayEstimate['steps'][number]>();
  for (const call of calls) {
    const step = steps.get(call.step) ?? { step: call.step, calls: 0, promptTokens: 0, outputTokens: 0, minutes: 0, splitMinutes: 0 };
    const prompt = Math.ceil(call.promptCharacters / CHARS_PER_TOKEN);
    const output = OUTPUT_PER_CALL[call.step] ?? 0;
    step.calls++;
    step.promptTokens += prompt;
    step.outputTokens += output;
    step.minutes += (prompt + output) / TOKENS_PER_MINUTE;
    step.splitMinutes += (prompt / PROMPT_TOKENS_PER_SECOND + output / OUTPUT_TOKENS_PER_SECOND) / 60;
    steps.set(call.step, step);
  }
  const list = [...steps.values()].map((step) => ({
    ...step,
    minutes: Math.round(step.minutes * 10) / 10,
    splitMinutes: Math.round(step.splitMinutes * 10) / 10,
  }));
  const sum = (pick: (step: (typeof list)[number]) => number) => Math.round(list.reduce((total, step) => total + pick(step), 0) * 10) / 10;
  return {
    steps: list,
    calls: sum((step) => step.calls),
    promptTokens: sum((step) => step.promptTokens),
    outputTokens: sum((step) => step.outputTokens),
    minutes: sum((step) => step.minutes),
    splitMinutes: sum((step) => step.splitMinutes),
  };
}

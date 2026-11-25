import type { BookKnowledgePassage } from '@bookorbit/types';
const point = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'quote', 'passage'],
  properties: { text: { type: 'string' }, quote: { type: 'string' }, passage: { type: 'integer' } },
};
export const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meaning', 'meaningQuote', 'meaningPassage', 'points', 'insufficient'],
  properties: {
    meaning: { type: 'string' },
    meaningQuote: { type: 'string' },
    meaningPassage: { type: 'integer' },
    points: { type: 'array', maxItems: 4, items: point },
    insufficient: { type: 'boolean' },
  },
};
// Constrained decoding collects evidence before committing to refusal by emitting keys in schema order.
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['points', 'answer', 'notInBook'],
  properties: { points: { type: 'array', maxItems: 4, items: point }, answer: { type: 'string' }, notInBook: { type: 'boolean' } },
};
export function evidencePrompt(task: string, passages: BookKnowledgePassage[]): string {
  const instructions = `${task}
Use only numbered passages, never general knowledge or everyday meanings. Dialogue may be opinion. Prefer definitions and explanations; explain what the term means, not where it is mentioned. Mere mentions do not deserve points. Without a definition or explanation, describe only how the term is used in these passages, or return insufficient. For a person or place, identify who or what it is and what has happened so far, using the latest passage for its latest state.
Each claim must say only what its quote supports, no firmer. Preserve might, could, negations, and who holds a view. If an idea is raised then rejected, say it is rejected. Never reverse a negation. A passing use of a word cannot establish its meaning: use insufficient or notInBook. Do not restate the question. Explain why it matters and its relation to nearest terms only when the passages say so. Stay compact.
meaning: one or two sentences in your own words, no quotation marks or passage numbers. insufficient is true only if passages truly say nothing about what the term is.
Each point text: your own words, one distinct fact, never repeat its quote or another point. At most four points. quote and meaningQuote: shortest exact supporting words, at least 4 and at most 25 words, copied character for character; cite passage and meaningPassage. For questions, build the short answer only from facts stated in your points; add no other claims. Answer only what evidence supports; otherwise notInBook is true. Return JSON only.
Invented example: term glimnet; passage 1: A glimnet is a mesh that catches drifting sparks. Passage 2: The glimnet now hangs above the gate.
{"meaning":"A glimnet is a spark-catching mesh.","meaningQuote":"a mesh that catches drifting sparks","meaningPassage":1,"points":[{"text":"It is currently suspended over the entrance.","quote":"now hangs above the gate","passage":2}],"insufficient":false}
`;
  // Reserve context for system instructions and the schema, including in plain mode.
  let budget = Math.max(0, 6800 - instructions.length);
  const evidence: { number: number; text: string }[] = [];
  for (const passage of passages) {
    const item = { number: passage.number, text: passage.text };
    const length = JSON.stringify(item).length + 1;
    if (length > budget) continue;
    evidence.push(item);
    budget -= length;
  }
  return instructions + JSON.stringify(evidence);
}

export function evidenceCharacterBudget(task: string): number {
  return Math.max(0, 6800 - evidencePrompt(task, []).length - 2);
}

export function answerPrompt(question: string, passages: BookKnowledgePassage[], focused = false): string {
  const focus = focused
    ? 'The question is about one name or term. Say who or what it is and its role, then what has happened to it or been said about it so far, using the latest passage for its latest state. Attribute a fact only when its passage clearly names who it is about; never carry he, she or they across passages.\n'
    : '';
  const instructions = `Answer this question using only the numbered passages: ${JSON.stringify(question)}
${focus}Facts come only from the passages, never from general knowledge or everyday meanings. Dialogue may be opinion, so say who holds a view. Keep might, could and negations. If an idea is raised then rejected, say it is rejected.
First collect the facts as points. Each point text is one distinct fact in your own words, with a quote of 4 to 25 words copied character for character from one passage, and that passage number. At most four points.
Then write answer: one to three short sentences built only from your points. If the passages answer only part of the question, answer that part and say plainly what they do not cover.
notInBook is true only when no passage states any fact that answers any part of the question. A word that appears only in passing, with nothing said about it, does not count as a fact. If you have a point, notInBook is false.
Return JSON only.
Invented examples.
Question "Who is Tarn, and why did he come back?" Passage 1: Tarn is the ferryman of the Sill. He fled north after the flood.
{"points":[{"text":"He runs the ferry on the Sill.","quote":"Tarn is the ferryman of the Sill","passage":1},{"text":"The flood made him flee northward.","quote":"He fled north after the flood","passage":1}],"answer":"Tarn is the Sill's ferryman, who fled north after the flood. The passages do not say why he came back.","notInBook":false}
Question "What is a glimnet?" Passage 1: He saw the glimnet again and walked on.
{"points":[],"answer":"","notInBook":true}
Passages: `;
  let budget = Math.max(0, 6800 - instructions.length - 2);
  const evidence: { number: number; text: string }[] = [];
  for (const passage of passages) {
    const item = { number: passage.number, text: passage.text };
    const length = JSON.stringify(item).length + 1;
    if (length > budget) continue;
    evidence.push(item);
    budget -= length;
  }
  return instructions + JSON.stringify(evidence);
}
export function answerCharacterBudget(question: string, focused = false): number {
  return Math.max(0, 6800 - answerPrompt(question, [], focused).length - 2);
}

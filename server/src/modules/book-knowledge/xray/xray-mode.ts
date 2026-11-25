import type { BookKnowledgeXrayMode } from '@bookorbit/types';

const NONFICTION =
  /\b(?:non-?fiction|philosophy|science|technology|computers?|artificial intelligence|history|biography|memoir|business|economics|politics|psychology|essays?|reference|self-help|mathematics|education)\b/i;
const FICTION = /(?<!non-?)\bfiction\b|\bnovels?\b|\bfantasy\b|\bromance\b|\bthrillers?\b|\bmyster(?:y|ies)\b|\bscience fiction\b/i;

/** Nonfiction when some subject says so and none says fiction; fiction otherwise, the pipeline's original shape. */
export function modeFromSubjects(subjects: readonly string[]): BookKnowledgeXrayMode {
  if (subjects.some((subject) => FICTION.test(subject))) return 'fiction';
  return subjects.some((subject) => NONFICTION.test(subject)) ? 'nonfiction' : 'fiction';
}

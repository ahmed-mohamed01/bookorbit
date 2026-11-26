import { LINES_SYSTEM } from '../../../story-guides/pipeline/lines-step';
import { NAMES_SYSTEM } from '../../../story-guides/pipeline/names-step';
import { SUMMARIES_SYSTEM } from '../../../story-guides/pipeline/summaries-step';
import { TIES_SYSTEM } from '../../../story-guides/pipeline/ties-step';

export const NOTE_WORDS = 100;
/** An id named in at least this many sentences of the unit must get a note, or null. */
export const NOTE_MIN_MENTIONS = 3;
export const ABILITY_GROUPS = ['path', 'class', 'level', 'spell', 'skill', 'trait', 'stat', 'gear', 'other'] as const;

/** Upstream's text between two markers, so the one pass follows its rules word for word. */
function slice(text: string, from: string, to: string | null, what: string): string {
  const start = text.indexOf(from);
  const end = to === null ? text.length : text.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`Upstream ${what} prompt changed shape`);
  return text.slice(start, end).trim();
}

/** NAMES_SYSTEM's rule that a description holds only what the chapter states. */
export const NOTE_DISCIPLINE = slice(NAMES_SYSTEM, 'Describe each entry only from what this chapter states.', null, 'names');
/** LINES_SYSTEM's identity facts and what to leave out, read against the stretch instead of notes. */
export const IDENTITY_FACTS = slice(LINES_SYSTEM, 'built only from facts the notes state', '\nKeep the current line', 'lines').replace(
  'built only from facts the notes state',
  'built only from facts the stretch states',
);
export const IDENTITY_LEAVE_OUT = slice(LINES_SYSTEM, 'Leave out scene events', 'Use the names exactly as given.', 'lines').replace(
  /\bnotes\b/g,
  'stretch',
);
export const TIE_RULES = slice(TIES_SYSTEM, 'Use only these types', '- Use the names exactly as listed', 'ties').replace(/\bpassage\b/g, 'stretch');
export const SUMMARY_RULES = slice(SUMMARIES_SYSTEM, 'Write two to four plain sentences', 'Answer with JSON only', 'summaries');

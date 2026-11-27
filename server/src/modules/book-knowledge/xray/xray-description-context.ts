export const THOUGHT_DESCRIPTION =
  'If the person appears only in one character’s thoughts, memories or hypotheticals, lead with their relation to that character ' +
  'and say how that character thinks of or remembers them. Attribute every would or could clause to the thinker, using their name. ' +
  'For example: “Tavia’s brother. Tavia thinks he would miss her if she left.”';

export const LASTING_ONLY =
  'Keep only what stays true and worth knowing chapters later: who they are, their role, lasting abilities, defining traits and ties. ' +
  'Leave out a passing moment: one touch, gesture, look, sensation, or what someone felt about one moment. ' +
  'A major event that changed things (a battle, a death, a first deadly encounter) is not a passing moment and may stay, above all for a place or creature ' +
  '(not: "her hand on the door leaves a glowing mark she finds strange").';

export const KIND_CONTENT =
  'What a line holds, by kind, written for what a reader wants to know. A person: what they are and where they come from, ' +
  'their role or position now, their key ties, what drives them, lasting abilities. A place: what kind of place it is and where, ' +
  'who lives in or holds it, why it matters to the story, and the major events that have happened there (a battle fought there, where someone died or was found). ' +
  'A creature: what it is, how dangerous, where found, and the major encounters with it (who fought it, what it cost). ' +
  'A group: what it is, who leads or belongs, what it wants. An item: what it is, what it does, who has it. ' +
  'A skill, spell or stat: what it does or measures and how it is gained or used.';

export const WRITTEN_VOICE_RULE =
  "A letter, log or message that a character writes speaks for its writer; its 'I' is never the narrator. For example, when a clerk " +
  'reads a sea captain’s logbook aloud, “I lost two men to the storm” is the captain’s loss, not the clerk’s. ';

/** Opens and closes a run of sentences the book sets off as a quoted letter, email, log or document. */
export const WRITTEN_OPEN = '<written>';
export const WRITTEN_CLOSE = '</written>';

/** For prompts that mark quoted writing: between the tags in a stretch, or with "written" before a sentence's number. */
export const WRITTEN_TEXT_RULE =
  `Sentences between ${WRITTEN_OPEN} tags, or marked written, are writing quoted in the story: a letter, email, log or document a character reads. ` +
  "Their 'I' and 'we' are its writer, never the narrator: in \"written [12] I sealed the vault myself\", the letter's writer sealed it. ";

export const NARRATOR_GENDER_RULE =
  "Use the narrator's gender only when the facts state it; otherwise write about the narrator without gendered pronouns. ";

export const DESCRIPTION_PROSE =
  'Write flowing prose, one or two sentences that tell who or what this is in the story, never a comma list of traits. ' +
  'Leave out levels, ranks of skills and stat numbers; those belong to the abilities list.';

const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const STAT_NUMBERS = /(?:^|[\s(])[+−-]\d|\b(?:level|beginner|intermediate|novice|apprentice|expert|master)\s+\d/i;

export function proseProblem(line: string): 'list' | 'stat-numbers' | null {
  if (STAT_NUMBERS.test(line)) return 'stat-numbers';
  for (const { segment } of SENTENCES.segment(line)) {
    if ((segment.match(/,/g)?.length ?? 0) >= 4) return 'list';
  }
  return null;
}

const MODAL = /\b(?:would|could)\b/gi;
const THINKING = String.raw`think(?:s|ing)?|thought|imagin(?:e|es|ed|ing)|(?:remember|recall|wonder|fear|expect)(?:s|ed|ing)?|believ(?:e|es|ed|ing)`;
const THINKER = String.raw`[\p{L}][\p{L}\p{M}'’-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’-]*)*`;
const THINKS = `${THINKER}\\s+(?:${THINKING})\\b`;
const IN_MIND = `in\\s+${THINKER}['’]s\\s+(?:mind|thoughts|memory|imagination)\\b`;
const AS_THOUGHT = new RegExp(`\\b(?:${THINKS}|according to\\s+${THINKER}|${IN_MIND})`, 'iu');
const TRAILING_THOUGHT = new RegExp(`^,\\s*(?:(?:as\\s+)?${THINKS}|${IN_MIND})`, 'iu');

export function unattributedModal(line: string): boolean {
  return line.split(/[.!?;]+|,?\s+\b(?:but|yet|however)\b|,\s+(?:and|so|then|while|whereas)\b/i).some((clause) => {
    for (const { index } of clause.matchAll(MODAL)) {
      if (AS_THOUGHT.test(clause.slice(0, index))) continue;
      const aside = clause.slice(index).match(/,\s*[^,]+$/)?.[0];
      if (!aside || !TRAILING_THOUGHT.test(aside)) return true;
    }
    return false;
  });
}

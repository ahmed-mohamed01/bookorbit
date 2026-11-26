export const THOUGHT_DESCRIPTION =
  'If the person appears only in one character’s thoughts, memories or hypotheticals, lead with their relation to that character ' +
  'and say how that character thinks of or remembers them. Attribute every would or could clause to the thinker, using their name. ' +
  'For example: “Tavia’s brother. Tavia thinks he would miss her if she left.”';

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

import { load } from 'cheerio';
import { escapeRegExp, WORD_EDGE } from '../../../story-guides/pipeline/name-text';
import type { Sentence } from '../../core/model';
import type { XrayEntity } from '../xray-entities';
import { namedCharacter, NARRATOR_ID, type PassCast } from '../pass/pass-cast';
import type { PassUnit } from '../pass/pass-units';

export const FIRST_PERSON_PER_THOUSAND = 20;
/**
 * Chunk votes, and a lead over every rival, after which the book's narrator is fixed and the stand-in joins them. The blurb
 * counts toward the lead only, so it never names a narrator on fewer real votes.
 */
export const NARRATOR_SETTLED_VOTES = 6;
export const NARRATOR_SETTLED_LEAD = 3;
/** Votes a section needs, all for one name, before its own first-person chunks are credited to that name. */
export const NARRATOR_SECTION_VOTES = 3;
const FIRST_PERSON = /^(?:I(?:['’](?:m|ve|d|ll))?|me|my|mine|myself)$/i;
const NARRATOR_KEY = 'xray:narrator';
const WORD_OR_QUOTE = /\p{L}+(?:['’]\p{L}+)*|\p{N}+|["“”'‘’«»]/gu;

export class NarrationDetector {
  private close: string | null = null;
  private spine: number | null = null;
  private paragraph: number | null = null;

  mentions(chunk: PassUnit, sentences: readonly Sentence[]): number[] {
    const narration: number[] = [];
    let words = 0;
    let firstPerson = 0;
    for (const ordinal of chunk.ordinals) {
      const sentence = sentences[ordinal - 1];
      if (sentence.heading || sentence.inset) continue;
      if (sentence.spineIndex !== this.spine) this.close = null;
      const newParagraph = sentence.spineIndex !== this.spine || sentence.paragraphIndex !== this.paragraph;
      this.spine = sentence.spineIndex;
      this.paragraph = sentence.paragraphIndex;
      let narrated = false;
      for (const { 0: token, index } of sentence.text.matchAll(WORD_OR_QUOTE)) {
        if (token === this.close) {
          // Multi-paragraph dialogue repeats a straight opening quote at the next paragraph.
          if (!newParagraph || index !== sentence.text.search(/\S/) || (token !== '"' && token !== "'")) this.close = null;
        } else if (token === '“' || token === '«' || token === '"' || token === '‘' || token === "'") {
          if (!this.close && (token !== "'" || !/\p{L}/u.test(sentence.text[index - 1] ?? '')))
            this.close = token === '“' ? '”' : token === '«' ? '»' : token === '‘' ? '’' : token;
        } else if (!this.close && /^[\p{L}\p{N}]/u.test(token)) {
          words++;
          narrated = true;
          if (FIRST_PERSON.test(token)) firstPerson++;
        }
      }
      if (narrated) narration.push(ordinal);
    }
    return firstPerson > 0 && firstPerson * 1000 >= FIRST_PERSON_PER_THOUSAND * words ? narration : [];
  }
}

const namedBy = (entity: XrayEntity, ordinal: number) =>
  namedCharacter(entity) && entity.names.some((name) => name.ordinal <= ordinal && name.text.toLowerCase() === entity.name.toLowerCase());

export class NarratorVotes {
  private readonly votes = new Map<XrayEntity, number>();
  private readonly sections = new Map<number, Map<XrayEntity, number>>();
  private readonly hints = new Map<string, boolean>();
  private description?: Promise<string>;
  private fixed: XrayEntity | null = null;

  constructor(
    private readonly cast: PassCast,
    private readonly readDescription?: () => Promise<string | null>,
  ) {}

  anonymous(ordinal: number): XrayEntity {
    const existing = this.cast.entity(NARRATOR_ID);
    if (existing) return existing;
    const narrator: XrayEntity = {
      id: NARRATOR_ID,
      key: NARRATOR_KEY,
      name: 'Narrator',
      kind: 'character',
      sub: null,
      importance: 2,
      rank: 0,
      count: 0,
      first: ordinal,
      ordinals: [],
      defining: new Set(),
      names: [{ text: 'Narrator', ordinal }],
      joins: [],
    };
    this.cast.add(narrator);
    return narrator;
  }

  record(pov: string | null, ordinal: number, section?: number): void {
    const entity = pov ? this.cast.entity(pov) : undefined;
    if (!entity || entity.id === NARRATOR_ID || !namedBy(entity, ordinal)) return;
    this.votes.set(entity, (this.votes.get(entity) ?? 0) + 1);
    if (section === undefined) return;
    const own = this.sections.get(section) ?? new Map<XrayEntity, number>();
    own.set(entity, (own.get(entity) ?? 0) + 1);
    this.sections.set(section, own);
  }

  /** The narrator once the votes leave no doubt; null until then. */
  get settled(): XrayEntity | null {
    return this.fixed;
  }

  /**
   * Who says "I" in a first-person chunk of `section` starting at `ordinal`, as the votes stand now: the section's own
   * narrator when its votes all name one person, else the book's settled narrator; null leaves it to the stand-in. A book
   * told by two narrators by turns never settles, so each long section is credited to its own.
   */
  ownerAt(section: number, ordinal: number): XrayEntity | null {
    const tally = new Map<XrayEntity, number>();
    for (const [entity, votes] of this.sections.get(section) ?? []) {
      const head = this.cast.headOf(entity, ordinal);
      tally.set(head, (tally.get(head) ?? 0) + votes);
    }
    const [only] = tally.size === 1 ? [...tally] : [];
    if (only && only[1] >= NARRATOR_SECTION_VOTES) return only[0];
    return this.fixed && this.cast.headOf(this.fixed, ordinal);
  }

  /** Fixes the book's narrator once one name has `NARRATOR_SETTLED_VOTES` votes and `NARRATOR_SETTLED_LEAD` times any rival's. */
  async settle(ordinal: number): Promise<XrayEntity | null> {
    if (this.fixed) return this.fixed;
    if (!this.votes.size) return null;
    this.description ??=
      this.readDescription?.().then((description) =>
        description
          ? load(description.replace(/<[^>]*>/g, ' '), {}, false)
              .root()
              .text()
          : '',
      ) ?? Promise.resolve('');
    const description = await this.description;
    const totals = new Map<XrayEntity, number>();
    for (const [entity, votes] of this.votes) {
      const head = this.cast.headOf(entity, ordinal);
      if (namedBy(head, ordinal)) totals.set(head, (totals.get(head) ?? 0) + votes);
    }
    let winner: { entity: XrayEntity; votes: number; total: number } | null = null;
    let rival = 0;
    for (const [entity, votes] of totals) {
      const names = new Set(
        [...entity.names, ...entity.joins.filter((join) => join.ordinal <= ordinal && join.key !== NARRATOR_KEY).flatMap((join) => join.names)]
          .filter((name) => name.ordinal <= ordinal)
          .map(({ text }) => text),
      );
      const hinted =
        !!description &&
        [...names].some((name) => {
          if (!this.hints.has(name)) this.hints.set(name, new RegExp(`${WORD_EDGE}${escapeRegExp(name)}${WORD_EDGE}`, 'iu').test(description));
          return this.hints.get(name);
        });
      const total = votes + Number(hinted);
      if (!winner || total > winner.total) {
        rival = Math.max(rival, winner?.total ?? 0);
        winner = { entity, votes, total };
      } else rival = Math.max(rival, total);
    }
    if (winner && winner.votes >= NARRATOR_SETTLED_VOTES && winner.total >= rival * NARRATOR_SETTLED_LEAD) this.fixed = winner.entity;
    return this.fixed;
  }
}

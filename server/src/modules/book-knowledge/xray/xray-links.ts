import { type XraySection } from './xray-evidence';

/** The first snapshot needs this many body sentences; each later one this factor more than the last. */
const FIRST_CHECKPOINT = 300;
const CHECKPOINT_GROWTH = 1.1;

/**
 * A connection as ranked from the text up to `from` only. It holds until `until` (exclusive), where a
 * later snapshot ranks the pair differently or drops it; null when it holds to the end of the build.
 */
export interface XrayLinkSnapshot {
  a: string;
  b: string;
  score: number;
  count: number;
  from: number;
  until: number | null;
}

/**
 * Section ends at which links are ranked again: the first after `first` body sentences, then
 * each at least `growth` times the previous one's count. Each choice looks only at the text
 * before it, so a reader's snapshot never depends on what follows. The last section end is always one.
 */
export function linkCheckpoints(sections: readonly XraySection[], first = FIRST_CHECKPOINT, growth = CHECKPOINT_GROWTH): number[] {
  const checkpoints: number[] = [];
  let seen = 0;
  let next = first;
  for (const [index, section] of sections.entries()) {
    seen += section.ordinals.length;
    if (seen >= next || index === sections.length - 1) {
      checkpoints.push(section.ordinals.at(-1)!);
      next = Math.ceil(seen * growth);
    }
  }
  return checkpoints;
}

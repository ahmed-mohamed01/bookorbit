import type { EngineUnitSpec } from './engines/web-serial-engine';
import { sequenceKey } from './web-serials-selection.utils';

export interface MoveItemInput {
  id: number;
  sequence: string;
  unitKey?: string | null;
  remoteRef?: unknown;
}

/** One unfinished unit of a job, expressed in the chapter sequences it needs. A volume or one-book unit stands for all its chapters. */
export interface MoveUnit {
  id: number;
  sequence: string;
  members: string[];
  volume: string | null;
}

export function describeMoveUnit(
  item: MoveItemInput,
  savedByKey: ReadonlyMap<string, EngineUnitSpec>,
  savedBySequence: ReadonlyMap<string, EngineUnitSpec>,
): MoveUnit {
  const stored = isRecord(item.remoteRef) && isRecord(item.remoteRef['unit']) ? item.remoteRef['unit'] : null;
  const saved = (item.unitKey ? savedByKey.get(item.unitKey) : undefined) ?? savedBySequence.get(item.sequence);
  const unit = stored ?? (saved ? (saved as unknown as Record<string, unknown>) : null);
  const remote = unit && isRecord(unit['remote']) ? unit['remote'] : null;
  const chapters = remote && Array.isArray(remote['chapters']) ? remote['chapters'] : null;
  const members = chapters
    ? chapters.flatMap((chapter) =>
        isRecord(chapter) && typeof chapter['sequence'] === 'string' && chapter['sequence'] ? [chapter['sequence']] : [],
      )
    : [];
  const volume = unit && unit['packaging'] === 'volume' && typeof unit['volume'] === 'string' && unit['volume'] ? unit['volume'] : null;
  return { id: item.id, sequence: item.sequence, members: members.length > 0 ? members : [item.sequence], volume };
}

export function indexSavedUnits(units: EngineUnitSpec[]): { byKey: Map<string, EngineUnitSpec>; bySequence: Map<string, EngineUnitSpec> } {
  const byKey = new Map<string, EngineUnitSpec>();
  const bySequence = new Map<string, EngineUnitSpec>();
  for (const unit of units) {
    byKey.set(unit.unitKey, unit);
    if (!bySequence.has(unit.sequence)) bySequence.set(unit.sequence, unit);
  }
  return { byKey, bySequence };
}

export function countMembers(units: MoveUnit[]): number {
  return units.reduce((sum, unit) => sum + unit.members.length, 0);
}

export function isFullyAvailable(unit: MoveUnit, available: ReadonlySet<string>): boolean {
  return unit.members.every((member) => available.has(sequenceKey(member)));
}

/** Chapters the target can take over: only units it has in full count. */
export function countAvailableMembers(units: MoveUnit[], available: ReadonlySet<string>): number {
  return units.reduce((sum, unit) => sum + (isFullyAvailable(unit, available) ? unit.members.length : 0), 0);
}

/** The volume each moved chapter had in the source job, expressed as target unit keys so the target job rebuilds the same books. */
export function carriedVolumes(units: MoveUnit[], targetUnits: EngineUnitSpec[]): Record<string, string> | null {
  const bySequence = new Map<string, string>();
  for (const unit of units) {
    if (!unit.volume) continue;
    for (const member of unit.members) bySequence.set(sequenceKey(member), unit.volume);
  }
  if (bySequence.size === 0) return null;
  const result: Record<string, string> = {};
  for (const target of targetUnits) {
    const volume = bySequence.get(sequenceKey(target.sequence));
    if (volume) result[target.unitKey] = volume;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

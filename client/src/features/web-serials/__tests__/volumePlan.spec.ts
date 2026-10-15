import { describe, expect, it } from 'vitest'

import { planWebSerialMangaVolumes, type WebSerialVolumePlanUnit } from '@bookorbit/types'

const unit = (sequence: string, volume: string | null): WebSerialVolumePlanUnit => ({ key: `c${sequence}`, sequence, volume })

// The shapes the owner saw on AllManga: newest chapters with no volume, and 1080.1 outside Vol. 107.
const ONE_PIECE: WebSerialVolumePlanUnit[] = [
  unit('1071', '106'),
  unit('1072', '106'),
  unit('1072.1', '106'),
  unit('1073', '106'),
  unit('1079', '107'),
  unit('1080', '107'),
  unit('1080.1', null),
  unit('1081', '107'),
  unit('1082', '107'),
  unit('1180', null),
  unit('1181', null),
  unit('1193', null),
]

const describePlan = (plan: ReturnType<typeof planWebSerialMangaVolumes>) =>
  plan.entries.map((entry) => (entry.type === 'volume' ? `vol:${entry.volume}[${entry.keys.length}]` : entry.key))

describe('planWebSerialMangaVolumes', () => {
  it('files whole volumes as books and every chapter outside a volume as a single chapter', () => {
    const plan = planWebSerialMangaVolumes(ONE_PIECE, { mode: 'all' })
    expect(describePlan(plan)).toEqual(['vol:106[4]', 'vol:107[4]', 'c1080.1', 'c1180', 'c1181', 'c1193'])
    expect(plan.partialVolumes).toEqual([])
    expect(plan.snappedRange).toBeNull()
  })

  it('widens a range that starts mid-volume to the whole volume and keeps the open end alone', () => {
    const plan = planWebSerialMangaVolumes(ONE_PIECE, { mode: 'range', fromSequence: '1072.1', toSequence: '1193' })
    expect(plan.snappedRange).toEqual({ fromSequence: '1071', toSequence: '1193' })
    expect(describePlan(plan)).toEqual(['vol:106[4]', 'vol:107[4]', 'c1080.1', 'c1180', 'c1181', 'c1193'])
  })

  it('widens a range that ends mid-volume to the last chapter of that volume', () => {
    const plan = planWebSerialMangaVolumes(ONE_PIECE, { mode: 'range', fromSequence: '1071', toSequence: '1080' })
    expect(plan.snappedRange).toEqual({ fromSequence: '1071', toSequence: '1082' })
    expect(describePlan(plan)).toEqual(['vol:106[4]', 'vol:107[4]', 'c1080.1'])
  })

  it('does not widen a range that already covers whole volumes or touches none', () => {
    expect(planWebSerialMangaVolumes(ONE_PIECE, { mode: 'range', fromSequence: '1071', toSequence: '1073' }).snappedRange).toBeNull()
    const trailing = planWebSerialMangaVolumes(ONE_PIECE, { mode: 'range', fromSequence: '1180', toSequence: '1181' })
    expect(trailing.snappedRange).toBeNull()
    expect(describePlan(trailing)).toEqual(['c1180', 'c1181'])
  })

  it('selecting only the unvolumed chapter between volume chapters gives that one chapter', () => {
    const plan = planWebSerialMangaVolumes(ONE_PIECE, { mode: 'range', fromSequence: '1080.1', toSequence: '1080.1' })
    expect(describePlan(plan)).toEqual(['c1080.1'])
  })

  it('falls back to chapters for a volume only partly selected by an exact list', () => {
    const plan = planWebSerialMangaVolumes(ONE_PIECE, { mode: 'keys', keys: new Set(['c1079', 'c1080', 'c1071', 'c1072', 'c1072.1', 'c1073']) })
    expect(describePlan(plan)).toEqual(['vol:106[4]', 'c1079', 'c1080'])
    expect(plan.partialVolumes).toEqual([{ volume: '107', selected: 2, total: 4 }])
  })

  it('keeps widening until interleaved volumes are whole', () => {
    const interleaved = [unit('1', '1'), unit('2', '2'), unit('3', '1'), unit('4', '2'), unit('5', '3')]
    const plan = planWebSerialMangaVolumes(interleaved, { mode: 'range', fromSequence: '1', toSequence: '3' })
    expect(plan.snappedRange).toEqual({ fromSequence: '1', toSequence: '4' })
    expect(describePlan(plan)).toEqual(['vol:1[2]', 'vol:2[2]'])
  })
})

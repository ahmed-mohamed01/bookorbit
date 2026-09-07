import { describe, expect, it } from 'vitest'
import { collapseEntryFor, readCollapseStore, writeCollapseEntry, type MonitoredCollapseStore } from './group-collapse'

describe('readCollapseStore', () => {
  it('reads a stored record back, entry by entry', () => {
    const store = readCollapseStore({ 'author-1': { all: true, groups: { 'A Series': false } } })

    expect(store).toEqual({ 'author-1': { all: true, groups: { 'A Series': false } } })
  })

  it('falls back to an empty record for anything that is not one', () => {
    expect(readCollapseStore(null)).toEqual({})
    expect(readCollapseStore(true)).toEqual({})
    expect(readCollapseStore(['author-1'])).toEqual({})
  })

  it('drops entries and section flags a release may have written in another shape', () => {
    const store = readCollapseStore({
      'author-1': 'collapsed',
      'author-2': { all: 'yes', groups: { 'A Series': true, 'B Series': 'maybe' } },
      'author-3': { groups: null },
    })

    expect(store).toEqual({
      'author-2': { all: false, groups: { 'A Series': true } },
      'author-3': { all: false, groups: {} },
    })
  })
})

describe('collapseEntryFor', () => {
  it('starts an unknown author expanded', () => {
    expect(collapseEntryFor({}, 'author-1')).toEqual({ all: false, groups: {} })
  })

  it('hands back a copy, so editing it cannot reach into the stored record', () => {
    const store: MonitoredCollapseStore = { 'author-1': { all: false, groups: { 'A Series': true } } }

    const entry = collapseEntryFor(store, 'author-1')
    entry.groups['A Series'] = false

    expect(store['author-1']?.groups).toEqual({ 'A Series': true })
  })
})

describe('writeCollapseEntry', () => {
  it('keeps every other author untouched', () => {
    const store: MonitoredCollapseStore = { 'author-1': { all: true, groups: {} } }

    const next = writeCollapseEntry(store, 'author-2', { all: false, groups: { Cosmere: true } })

    expect(next).toEqual({ 'author-1': { all: true, groups: {} }, 'author-2': { all: false, groups: { Cosmere: true } } })
  })

  it('forgets an author whose sections are all back to expanded', () => {
    const store: MonitoredCollapseStore = { 'author-1': { all: true, groups: { 'A Series': false } } }

    expect(writeCollapseEntry(store, 'author-1', { all: false, groups: {} })).toEqual({})
  })

  it('trims the least recently written authors once the record is full', () => {
    let store: MonitoredCollapseStore = {}
    for (const id of ['a', 'b', 'c']) store = writeCollapseEntry(store, id, { all: true, groups: {} }, 2)

    expect(Object.keys(store)).toEqual(['b', 'c'])
  })

  it('counts a rewrite as recent use, so an author in daily use is never the one trimmed', () => {
    let store: MonitoredCollapseStore = {}
    for (const id of ['a', 'b']) store = writeCollapseEntry(store, id, { all: true, groups: {} }, 2)
    store = writeCollapseEntry(store, 'a', { all: true, groups: { 'A Series': false } }, 2)
    store = writeCollapseEntry(store, 'c', { all: true, groups: {} }, 2)

    expect(Object.keys(store)).toEqual(['a', 'c'])
  })
})

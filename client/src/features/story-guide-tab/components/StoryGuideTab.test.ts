import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import type { BookDetail, ForkStoryRecap, StoryGuideFixesChoice, StoryGuideStatus } from '@bookorbit/types'
import type { StoryGuideAction } from '@/features/story-guide/lib/story-guide-presentation'
import { getStoryGuideStatus } from '@/features/story-guide/api/story-guide.api'
import { fetchStoryGuide, fetchStoryRecap } from '../api/story-guide-content.api'
import { fixtureCut, guideFixture } from '../lib/story-guide.test-fixture'
import StoryGuideTab from './StoryGuideTab.vue'

const progress = vi.hoisted(() => ({ refresh: null as (() => Promise<void>) | null }))
vi.mock('@/features/book/composables/useBookProgressRefresh', () => ({
  useBookProgressRefresh: (callback: () => Promise<void>) => {
    progress.refresh = callback
  },
}))
vi.mock('../api/story-guide-content.api', () => ({
  fetchStoryGuide: vi.fn<typeof fetchStoryGuide>(),
  fetchStoryRecap: vi.fn<typeof fetchStoryRecap>(),
}))

const access = vi.hoisted(() => ({ mayBuild: true }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => access.mayBuild }),
}))
vi.mock('@/features/story-guide/api/story-guide.api', () => ({ getStoryGuideStatus: vi.fn<typeof getStoryGuideStatus>() }))

vi.mock('@/features/story-guide/composables/useStoryGuideStatus', async () => {
  const { storyGuidePresentation } = await import('@/features/story-guide/lib/story-guide-presentation')
  const { computed } = await import('vue')
  return {
    useStoryGuideStatus: () => ({
      status,
      presentation: computed(() => storyGuidePresentation({ status: status.value })),
      pending: shallowRef(null),
      perform,
      reload,
    }),
  }
})

const built = {
  fileId: 41,
  textKey: guideFixture.textKey,
  canManage: true,
  build: { allowed: true },
  job: null,
  guide: { builtAt: guideFixture.builtAt, coverage: 1, format: 1, outdated: false, modelsChanged: false },
} satisfies StoryGuideStatus
const status = shallowRef<StoryGuideStatus | null>(built)
const perform = vi.fn<(action: StoryGuideAction, fixes?: StoryGuideFixesChoice) => Promise<void>>()
const reload = vi.fn<() => Promise<void>>()
const FUTURE = ['Captain Ana', 'Future profile', 'Future tie', 'Future summary', 'Future ending', 'Future note', 'Future name', 'Future pair note']
const position = { chapterIndex: 1, percentage: 48, cfi: 'saved-cfi', chapterTitle: 'At the gate' }
const recap = {
  state: 'ok',
  cut: fixtureCut,
  position,
  previously: [
    { s: 0, title: 'Arrival', text: 'They arrived.' },
    { s: 1, title: 'At the gate', text: 'The gate opened.' },
  ],
  stop: { state: 'ok', text: 'They are at the gate.', cached: false },
} satisfies ForkStoryRecap
let wrapper: VueWrapper | undefined

async function openTab(files: Array<{ format: string; role: string }> = [{ format: 'epub', role: 'primary' }]) {
  wrapper = mount(StoryGuideTab, {
    props: { book: { id: 6, coverSource: null, files } as BookDetail },
    attachTo: document.body,
    global: { stubs: { RouterLink: true } },
  })
  await flushPromises()
  return wrapper
}

function button(tab: VueWrapper, label: string) {
  const control = tab.findAll('button').find((entry) => entry.text().startsWith(label))
  if (!control) throw new Error(`Missing button: ${label}`)
  return control
}

beforeEach(() => {
  access.mayBuild = true
  status.value = built
  vi.mocked(fetchStoryGuide).mockResolvedValue(guideFixture)
  vi.mocked(getStoryGuideStatus).mockResolvedValue({ kind: 'fresh', status: built, etag: null })
  vi.mocked(fetchStoryRecap).mockImplementation(async (_id, stop) => (stop ? recap : { ...recap, stop: { state: 'skipped' } }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.clearAllMocks()
})

// `block` and the clamp's `display: -webkit-box` set the same property, so a clamped summary must not carry `block`.
function expectClamped(classes: string[], clamped: boolean) {
  expect(classes.includes('line-clamp-2')).toBe(clamped)
  expect(classes.includes('block')).toBe(!clamped)
}

describe('StoryGuideTab', () => {
  it('opens at saved progress, requests the recap, and renders only cut chapter and entity content', async () => {
    const tab = await openTab()
    expect(tab.text()).toContain('Up to 48%, At the gate')
    expect(tab.text()).toContain('They are at the gate.')
    expect(tab.text().indexOf('The gate opened.')).toBeLessThan(tab.text().indexOf('They arrived.'))
    expect(fetchStoryGuide).toHaveBeenCalledWith(41, expect.any(AbortSignal))
    expect(vi.mocked(fetchStoryRecap).mock.calls.map(([id, stop]) => [id, stop])).toEqual([
      [41, false],
      [41, true],
    ])
    await button(tab, 'Refresh').trigger('click')
    expect(fetchStoryRecap).toHaveBeenLastCalledWith(41, true, expect.any(AbortSignal))

    await button(tab, 'Timeline').trigger('click')
    expect(tab.text()).toContain('You are here, 48%')
    expect(tab.text()).toContain('Ana arrived.')
    expect(tab.text()).not.toContain('Future note')
    await button(tab, 'Ben').trigger('click')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Recently')
    document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()
    await flushPromises()

    await button(tab, 'Chapters').trigger('click')
    expect(tab.text()).toContain('The return')
    expect(tab.text()).toContain('1 later part is hidden')
    expect(tab.text()).not.toContain('Future summary')
    expect(tab.text()).not.toContain('Future ending')

    await button(tab, 'Characters').trigger('click')
    expect(tab.text()).toContain('Also known as Annie')
    expect(tab.text()).not.toContain('Captain Ana')
    expect(tab.text()).not.toContain('Future profile')
    await tab.get('input[type=search]').setValue('annie')
    expect(tab.text()).not.toContain('The Keeper')
    expect(tab.text()).toContain('A visitor')

    await button(tab, 'Constellation').trigger('click')
    expect(tab.findAll('line[stroke-dasharray]')).toHaveLength(1)
    await tab.get('input[type=checkbox]').setValue(false)
    expect(tab.findAll('line[stroke-dasharray]')).toHaveLength(0)
    await tab.get('g[aria-label="Ana"]').trigger('click')
    await button(tab, 'Open').trigger('click')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Who they are')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).not.toContain('Future tie')
  })

  it('draws the timeline as one line with chapter dots, plain notes, the cut marker and the locked card', async () => {
    const tab = await openTab()
    await button(tab, 'Timeline').trigger('click')
    const timeline = tab.get('[data-testid=story-guide-timeline]')
    const headings = timeline.findAll('h3')
    expect(headings.map((entry) => entry.text())).toEqual(['Arrival 0%', expect.stringMatching(/^At the gate \d+%Reading$/)])
    const dots = timeline.findAll('h3').map((entry) => entry.element.previousElementSibling?.className ?? '')
    expect(dots[0]).toContain('bg-card')
    expect(dots[1]).toContain('bg-info')
    const notes = timeline.findAll('li')
    expect(notes.map((entry) => entry.text().replace(/\s+/g, ' '))).toEqual(['Ana arrived. Ana', 'The gate opens for Ben. Ben'])
    expect(notes.every((entry) => !entry.classes().includes('border'))).toBe(true)
    expect(timeline.findAll('p').at(-1)?.text()).toBe('You are here, 48%')
    expect(tab.get('[data-testid=story-guide-ahead]').text()).toBe('The rest of At the gate and one more chapter open as you read.')
    expect(tab.text()).not.toContain('Move')
  })

  it('locks every chapter without a saved position', async () => {
    vi.mocked(fetchStoryRecap).mockResolvedValue({ state: 'no-position', cut: null, previously: [], stop: { state: 'skipped' } })
    const tab = await openTab()
    expect(tab.text()).toContain('Start reading to see the story so far.')
    expect(fetchStoryRecap).toHaveBeenCalledTimes(1)
    expect(button(tab, 'Characters').attributes('disabled')).toBeDefined()
    await button(tab, 'Chapters').trigger('click')
    expect(tab.findAll('[aria-label="Hidden until you reach it"]')).toHaveLength(3)
    expect(tab.text()).not.toContain('They arrived.')
    expect(tab.text()).toContain('The return')
  })

  it('shows the previous chapters when Reading help is off', async () => {
    vi.mocked(fetchStoryRecap).mockResolvedValue({ ...recap, stop: { state: 'off' } })
    const tab = await openTab()
    expect(tab.text()).toContain('Reading help is off.')
    expect(tab.text()).toContain('Previously')
    expect(tab.text()).not.toContain('Where you stopped')
  })

  it('shows its own empty panel with Build and the estimate before a guide exists', async () => {
    status.value = { ...built, guide: null, estimate: { minutes: null, cost: 0.19 } }
    const tab = await openTab()
    const panel = tab.get('[data-testid=story-guide-tab-empty]')
    expect(panel.text()).toContain('No story guide yet')
    expect(panel.text()).toContain('cut at where you are so nothing ahead is spoiled')
    expect(panel.get('[data-testid=story-guide-tab-estimate]').text()).toBe('About $0.19. The time shows after the first finished build.')
    expect(panel.text()).toContain("sent to the server's AI provider. Your reading position and notes are not.")
    expect(panel.text()).not.toContain('Someone with permission')
    expect(tab.find('[data-testid=story-guide-card]').exists()).toBe(false)
    expect(fetchStoryGuide).not.toHaveBeenCalled()

    await button(tab, 'Build story guide').trigger('click')
    expect(perform).not.toHaveBeenCalled()
    document.body.querySelector<HTMLButtonElement>('[data-choice="build"]')?.click()
    await flushPromises()
    expect(perform).toHaveBeenCalledWith('build', undefined)
  })

  it('shows a first build as a building panel with real progress and Cancel', async () => {
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'running', phase: 'lines', done: 2, total: 10, minutesLeft: 4 } }
    const tab = await openTab()
    const panel = tab.get('[data-testid=story-guide-tab-empty]')
    expect(panel.attributes('role')).toBe('status')
    expect(panel.text()).toContain('Building the story guide')
    expect(panel.text()).toContain('You can leave this page. The guide shows up here when it is done.')
    expect(panel.text()).toContain('Writing descriptions, chapter 3 of 10')
    expect(panel.text()).toContain('About 4 minutes left')
    expect(panel.get('[role=progressbar]').attributes('aria-valuenow')).toBe('20')
    expect(panel.find('[data-testid=story-guide-tab-build]').exists()).toBe(false)
    expect(tab.find('[data-testid=story-guide-card]').exists()).toBe(false)

    await button(tab, 'Cancel build').trigger('click')
    expect(perform).not.toHaveBeenCalled()
    document.body.querySelector<HTMLButtonElement>('[data-choice="cancel-build"]')?.click()
    await flushPromises()
    expect(perform).toHaveBeenCalledWith('cancelBuild', undefined)
  })

  it('shows an update in progress as a bar above the guide', async () => {
    status.value = { ...built, job: { kind: 'update', state: 'running', phase: 'summaries', done: 0, total: 4 } }
    const tab = await openTab()
    const bar = tab.get('[data-testid=story-guide-tab-job]')
    expect(bar.text()).toContain('Updating the story guide Writing summaries, chapter 1 of 4')
    expect(bar.get('[role=progressbar]').attributes('aria-valuenow')).toBe('0')
    expect(tab.text()).toContain('Up to 48%, At the gate')
    expect(tab.find('[data-testid=story-guide-tab-empty]').exists()).toBe(false)
    expect(tab.find('[data-testid=story-guide-card]').exists()).toBe(false)
    await bar.get('[data-action=cancelBuild]').trigger('click')
    expect(document.body.querySelector('[data-testid=story-guide-confirmation]')).not.toBeNull()
  })

  it('shows a paused first build with its reason, Resume and Cancel', async () => {
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'paused', reason: 'user' } }
    const tab = await openTab()
    const panel = tab.get('[data-testid=story-guide-tab-empty]')
    expect(panel.text()).toContain('No story guide yet')
    expect(panel.text()).toContain('Paused. It waits until someone resumes it.')
    expect(panel.findAll('[data-action]').map((entry) => entry.attributes('data-action'))).toEqual(['resume', 'cancelBuild'])
    await panel.get('[data-action=resume]').trigger('click')
    expect(perform).toHaveBeenCalledWith('resume')
  })

  it('shows a failed update as a bar with Try again and Dismiss over the guide', async () => {
    status.value = { ...built, job: { kind: 'update', state: 'failed', reason: 'error' } }
    const tab = await openTab()
    const bar = tab.get('[data-testid=story-guide-tab-job]')
    expect(bar.text()).toContain("Updating the story guide The story guide couldn't be built.")
    expect(bar.findAll('[data-action]').map((entry) => entry.attributes('data-action'))).toEqual(['retry', 'dismiss'])
    expect(tab.text()).toContain('Up to 48%, At the gate')
    await bar.get('[data-action=retry]').trigger('click')
    expect(perform).toHaveBeenCalledWith('retry')
    await bar.get('[data-action=dismiss]').trigger('click')
    expect(perform).toHaveBeenCalledWith('dismiss')
    expect(tab.find('[data-testid=story-guide-card]').exists()).toBe(false)
  })

  it('offers the existing update confirmation for an outdated guide', async () => {
    status.value = { ...built, guide: { ...built.guide, outdated: true } }
    const tab = await openTab()
    expect(tab.text()).toContain('An improved story guide is available.')
    await button(tab, 'Update').trigger('click')
    expect(document.body.querySelector('[data-testid=story-guide-confirmation]')).not.toBeNull()
    expect(perform).not.toHaveBeenCalled()
  })

  it('keeps the view mounted on a progress event and drops the stop text when a reread moves the cut backward', async () => {
    const tab = await openTab()
    let finish: (result: ForkStoryRecap) => void = () => {}
    vi.mocked(fetchStoryRecap).mockClear()
    vi.mocked(fetchStoryRecap).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const refresh = progress.refresh?.()
    await flushPromises()
    expect(tab.text()).toContain('The gate opened.')
    expect(tab.text()).toContain('They are at the gate.')
    expect(tab.text()).not.toContain('Loading the story guide')
    const earlier = {
      ...recap,
      cut: { s: 0, placedQuotes: [] },
      position: { ...position, chapterIndex: 0, percentage: 4, chapterTitle: 'Arrival' },
      previously: [],
      stop: { state: 'skipped' },
    } satisfies ForkStoryRecap
    finish(earlier)
    await refresh
    await flushPromises()
    expect(tab.text()).toContain('Up to 4%, Arrival')
    expect(tab.text()).not.toContain('The gate opened.')
    expect(tab.text()).not.toContain('They are at the gate.')
    expect(vi.mocked(fetchStoryRecap).mock.calls.map(([id, stop]) => [id, stop])).toEqual([[41, false]])
  })

  it('keeps the stop text and buys no recap when progress moves forward', async () => {
    const tab = await openTab()
    vi.mocked(fetchStoryRecap).mockClear()
    vi.mocked(fetchStoryRecap).mockResolvedValue({ ...recap, position: { ...position, percentage: 52 }, stop: { state: 'skipped' } })
    await progress.refresh?.()
    await flushPromises()
    expect(tab.text()).toContain('Up to 52%, At the gate')
    expect(tab.text()).toContain('They are at the gate.')
    expect(vi.mocked(fetchStoryRecap).mock.calls.map(([id, stop]) => [id, stop])).toEqual([[41, false]])
  })

  it('holds a progress event while a recap is in flight and applies it once the recap settles', async () => {
    let finishStop: (result: ForkStoryRecap) => void = () => {}
    const earlier = {
      ...recap,
      cut: { s: 0, placedQuotes: [] },
      position: { ...position, chapterIndex: 0, percentage: 4, chapterTitle: 'Arrival' },
      previously: [],
      stop: { state: 'skipped' },
    } satisfies ForkStoryRecap
    vi.mocked(fetchStoryRecap).mockImplementation((_id, stop) =>
      stop
        ? new Promise<ForkStoryRecap>((resolve) => {
            finishStop = resolve
          })
        : Promise.resolve({ ...recap, stop: { state: 'skipped' } }),
    )
    const tab = await openTab()
    const [, , signal] = vi.mocked(fetchStoryRecap).mock.calls.at(-1)!
    vi.mocked(fetchStoryRecap).mockClear()
    await progress.refresh?.()
    expect(fetchStoryRecap).not.toHaveBeenCalled()
    expect(signal?.aborted).toBe(false)

    vi.mocked(fetchStoryRecap).mockResolvedValue(earlier)
    finishStop(recap)
    await flushPromises()
    expect(vi.mocked(fetchStoryRecap).mock.calls.map(([id, stop]) => [id, stop])).toEqual([[41, false]])
    expect(tab.text()).toContain('Up to 4%, Arrival')
    expect(document.body.innerHTML).not.toContain('They are at the gate.')
  })

  it('drops the stop text when a progress answer at the same percentage names another CFI', async () => {
    const tab = await openTab()
    expect(tab.text()).toContain('They are at the gate.')
    vi.mocked(fetchStoryRecap).mockResolvedValue({ ...recap, position: { ...position, cfi: 'earlier-cfi' }, stop: { state: 'skipped' } })
    await progress.refresh?.()
    await flushPromises()
    expect(document.body.innerHTML).not.toContain('They are at the gate.')
  })

  it('keeps the stop text when a progress answer repeats the same percentage and CFI', async () => {
    const tab = await openTab()
    vi.mocked(fetchStoryRecap).mockResolvedValue({ ...recap, stop: { state: 'skipped' } })
    await progress.refresh?.()
    await flushPromises()
    expect(tab.text()).toContain('They are at the gate.')
  })

  it('aborts an earlier progress read when a newer event arrives', async () => {
    await openTab()
    vi.mocked(fetchStoryRecap).mockClear()
    vi.mocked(fetchStoryRecap).mockImplementation(() => new Promise<ForkStoryRecap>(() => {}))
    void progress.refresh?.()
    const [, , first] = vi.mocked(fetchStoryRecap).mock.calls[0]!
    void progress.refresh?.()
    expect(first?.aborted).toBe(true)
    expect(fetchStoryRecap).toHaveBeenCalledTimes(2)
  })

  it('shows chapter titles without spine numbers', async () => {
    const tab = await openTab()
    expect(tab.find('[aria-label="Story guide actions"]').exists()).toBe(true)
    expect(tab.text()).not.toMatch(/Chapter \d/)
    await button(tab, 'Chapters').trigger('click')
    expect(tab.text()).toContain('2 of 3 open')
    await button(tab, 'Characters').trigger('click')
    expect(tab.text()).toContain('Since Arrival')
    expect(tab.text()).toContain('Since At the gate')
  })

  it('lets readers without build permission read the guide but not build it', async () => {
    access.mayBuild = false
    vi.mocked(getStoryGuideStatus).mockResolvedValue({ kind: 'fresh', status: { ...built, guide: { ...built.guide, outdated: true } }, etag: null })
    const tab = await openTab()
    expect(getStoryGuideStatus).toHaveBeenCalledWith(6, null, null)
    expect(tab.text()).toContain('Up to 48%, At the gate')
    expect(tab.text()).toContain('They are at the gate.')
    expect(tab.find('[data-testid=story-guide-tab-build]').exists()).toBe(false)
    expect(tab.findAll('button').some((entry) => entry.text().startsWith('Update'))).toBe(false)
    expect(tab.find('[aria-label="Story guide actions"]').exists()).toBe(false)
  })

  it('tells readers without build permission when no guide exists', async () => {
    access.mayBuild = false
    vi.mocked(getStoryGuideStatus).mockResolvedValue({
      kind: 'fresh',
      status: { ...built, canManage: false, build: { allowed: false }, guide: null },
      etag: null,
    })
    const tab = await openTab()
    const panel = tab.get('[data-testid=story-guide-tab-empty]')
    expect(panel.text()).toContain('No story guide yet')
    expect(panel.text()).toContain('Someone with permission to build story guides can build one for this book.')
    expect(panel.find('[data-testid=story-guide-tab-build]').exists()).toBe(false)
    expect(panel.findAll('button')).toHaveLength(0)
    expect(fetchStoryGuide).not.toHaveBeenCalled()
  })

  it('shows readers an unavailable status with Refresh when the status is missing', async () => {
    access.mayBuild = false
    vi.mocked(getStoryGuideStatus).mockResolvedValue({ kind: 'missing' })
    const tab = await openTab()
    expect(tab.text()).toContain('The story guide could not be loaded.')
    vi.mocked(getStoryGuideStatus).mockResolvedValue({ kind: 'fresh', status: built, etag: null })
    await button(tab, 'Refresh').trigger('click')
    await flushPromises()
    expect(getStoryGuideStatus).toHaveBeenCalledTimes(2)
    expect(tab.text()).toContain('Up to 48%, At the gate')
  })

  it('shows builders the loading row while the status is pending', async () => {
    status.value = null
    vi.mocked(getStoryGuideStatus).mockReturnValue(new Promise(() => {}))
    const tab = await openTab()
    expect(tab.text()).toContain('Loading the story guide')
  })

  it('shows builders unavailable with Refresh when the status fails, and Refresh asks again', async () => {
    status.value = null
    vi.mocked(getStoryGuideStatus).mockRejectedValue(new Error('down'))
    const tab = await openTab()
    expect(tab.text()).toContain('The story guide could not be loaded.')
    await button(tab, 'Refresh').trigger('click')
    await flushPromises()
    expect(getStoryGuideStatus).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('caps Previously at the newest four chapters and links to all of them', async () => {
    const sections = Array.from({ length: 10 }, (_, s) => ({ s, title: `Part ${s + 1}`, chars: 100, h: 'h' }))
    vi.mocked(fetchStoryGuide).mockResolvedValue({ ...guideFixture, sections })
    const previously = sections.map(({ s, title }) => ({ s, title, text: `Summary ${s}` }))
    vi.mocked(fetchStoryRecap).mockImplementation(async (_id, stop) => ({
      ...recap,
      cut: { s: 9, placedQuotes: [] },
      previously,
      stop: stop ? recap.stop : { state: 'skipped' },
    }))
    const tab = await openTab()
    const list = tab.get('[data-testid=story-guide-previously]')
    expect(list.findAll('li').map((entry) => entry.find('span span').text())).toEqual(['Part 10', 'Part 9', 'Part 8', 'Part 7'])
    expect(list.get('button').attributes('aria-expanded')).toBe('false')
    expectClamped(list.get('button span.mt-1').classes(), true)
    await list.get('button').trigger('click')
    expect(list.get('button').attributes('aria-expanded')).toBe('true')
    expectClamped(list.get('button span.mt-1').classes(), false)
    await button(tab, 'All chapters').trigger('click')
    expect(tab.text()).toContain('of 10 open')
    const chapter = tab.findAll('ol button[aria-expanded]').find((entry) => entry.find('span.mt-1').exists())!
    expectClamped(chapter.get('span.mt-1').classes(), true)
    await chapter.trigger('click')
    expectClamped(chapter.get('span.mt-1').classes(), false)
  })

  it('labels a kept stop text with the position it was written for after progress moves forward', async () => {
    const tab = await openTab()
    vi.mocked(fetchStoryRecap).mockResolvedValue({
      ...recap,
      cut: { s: 2, placedQuotes: [] },
      position: { ...position, chapterIndex: 2, percentage: 80, chapterTitle: 'The return' },
      stop: { state: 'skipped' },
    })
    await progress.refresh?.()
    await flushPromises()
    expect(tab.text()).toContain('Up to 80%, The return')
    expect(tab.text()).toContain('Where you stopped, At the gate')
    expect(tab.text()).toContain('Recap up to 48%')
    expect(tab.get('[data-testid=story-guide-stop-behind]').text()).toBe('Written at 48%. Refresh for where you are now.')
  })

  it('asks for a refresh when a reread moves the cut back with Story so far open', async () => {
    const tab = await openTab()
    vi.mocked(fetchStoryRecap).mockResolvedValue({
      ...recap,
      cut: { s: 0, placedQuotes: [] },
      position: { ...position, chapterIndex: 0, percentage: 4, chapterTitle: 'Arrival' },
      previously: [],
      stop: { state: 'skipped' },
    })
    await progress.refresh?.()
    await flushPromises()
    expect(tab.text()).toContain('Refresh for a recap of where you are now.')
    expect(tab.text()).not.toContain('unavailable for this position')
  })

  it('shows readers the AI note and no update banner they cannot act on', async () => {
    access.mayBuild = false
    vi.mocked(getStoryGuideStatus).mockResolvedValue({
      kind: 'fresh',
      status: { ...built, canManage: false, guide: { ...built.guide, outdated: true } },
      etag: null,
    })
    const tab = await openTab()
    expect(tab.text()).toContain('Characters, places and ties are found by AI and can be wrong.')
    expect(tab.text()).not.toContain('An improved story guide is available.')
  })

  it('shows the pair note on a tie row and nothing past the cut', async () => {
    const tab = await openTab()
    await button(tab, 'Characters').trigger('click')
    await button(tab, 'Ana').trigger('click')
    await flushPromises()
    const sheet = document.body.querySelector('[role="dialog"]')!
    expect(sheet.textContent).toContain('Ana trusts Ben at the gate.')
    expect(sheet.textContent).not.toContain('Future pair note')
  })

  it('keeps every future string out of the markup in every section and sheet', async () => {
    const tab = await openTab()
    const leaks = () => FUTURE.filter((text) => document.body.innerHTML.includes(text))
    expect(leaks()).toEqual([])
    for (const label of ['Timeline', 'Chapters', 'Characters', 'Constellation']) {
      await button(tab, label).trigger('click')
      expect(leaks()).toEqual([])
    }
    for (const key of ['Ana', 'Ben', 'The Keeper', 'The gate']) {
      await tab.get(`g[aria-label="${key}"]`).trigger('click')
      await button(tab, 'Open').trigger('click')
      await flushPromises()
      expect(leaks()).toEqual([])
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()
      await flushPromises()
    }
  })

  it('shows the latest Timeline chapters first and earlier ones on request', async () => {
    const sections = Array.from({ length: 25 }, (_, s) => ({ s, title: `Part ${s + 1}`, chars: 100, h: 'h' }))
    const timeline = sections.map(({ s }) => ({ note: `Note ${s}`, at: { s, o: 0, q: `q${s}` }, through: { s, end: true as const }, chapter: null }))
    vi.mocked(fetchStoryGuide).mockResolvedValue({
      ...guideFixture,
      sections,
      chronicle: { ...guideFixture.chronicle!, entities: { ana: { about: [], timeline } } },
    })
    vi.mocked(fetchStoryRecap).mockImplementation(async (_id, stop) => ({
      ...recap,
      cut: { s: 25, placedQuotes: [] },
      stop: stop ? recap.stop : { state: 'skipped' },
    }))
    const tab = await openTab()
    await button(tab, 'Timeline').trigger('click')
    const headings = () =>
      tab
        .get('[data-testid=story-guide-timeline]')
        .findAll('h3')
        .map((entry) => entry.text().split(' ').slice(0, 2).join(' '))
    expect(headings()).toHaveLength(10)
    expect(headings()[0]).toBe('Part 16')
    expect(headings().at(-1)).toBe('Part 25')
    expect(tab.get('[data-testid=story-guide-earlier]').text()).toBe('Show earlier chapters (15)')
    await tab.get('[data-testid=story-guide-earlier]').trigger('click')
    expect(headings()).toHaveLength(20)
    expect(headings()[0]).toBe('Part 6')
  })

  it('lists the five build steps with the current one marked', async () => {
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'running', phase: 'lines', done: 16, total: 24, minutesLeft: 4 } }
    const tab = await openTab()
    const steps = tab.get('[data-testid=story-guide-tab-steps]').findAll('li')
    expect(steps.map((entry) => [entry.text(), entry.attributes('data-state')])).toEqual([
      ['Reading the book', 'done'],
      ['Finding names', 'done'],
      ["Checking who's who", 'done'],
      ['Writing descriptions, chapter 17 of 24', 'now'],
      ['Finishing up', 'pending'],
    ])
    expect(tab.findAll('[aria-current=step]')).toHaveLength(1)
    expect(tab.text()).toContain('About 4 minutes left')
  })

  it('names the step a unit start or end is on instead of a bare building line', async () => {
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'running', phase: 'bk', done: 1, total: 1 } }
    let tab = await openTab()
    expect(tab.get('[data-testid=story-guide-tab-empty] [role=progressbar]').attributes('aria-label')).toBe('Finishing up')
    tab.unmount()
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'running', phase: 'bk', done: 0, total: 1 } }
    tab = await openTab()
    expect(tab.get('[data-testid=story-guide-tab-empty] [role=progressbar]').attributes('aria-label')).toBe('Reading the book')
  })

  it('shows no step list for a queued build, an update over a guide, or minutes before they are known', async () => {
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'queued', position: 2 } }
    let tab = await openTab()
    expect(tab.find('[data-testid=story-guide-tab-steps]').exists()).toBe(false)
    tab.unmount()
    status.value = { ...built, job: { kind: 'update', state: 'running', phase: 'review', done: 1, total: 4 } }
    tab = await openTab()
    expect(tab.find('[data-testid=story-guide-tab-steps]').exists()).toBe(false)
    tab.unmount()
    status.value = { ...built, guide: null, job: { kind: 'build', state: 'running', phase: 'review', done: 1, total: 4, minutesLeft: null } }
    tab = await openTab()
    expect(tab.find('[data-testid=story-guide-tab-steps]').exists()).toBe(true)
    expect(tab.text()).not.toContain('minutes left')
  })
})

describe('StoryGuideTab without a supported file', () => {
  it.each([
    [
      'audio',
      [{ format: 'm4b', role: 'primary' }],
      'No story guide for audiobooks',
      "Story guides are built from a book's text, so they need an ebook. Add an EPUB, KEPUB, MOBI, AZW or AZW3 file of this book to build one.",
    ],
    [
      'comic',
      [{ format: 'cbz', role: 'primary' }],
      'No story guide for comics and manga',
      "Story guides are built from a book's text. Comics and manga tell their story mostly in pictures, so a guide can't be made from them.",
    ],
    [
      'format',
      [
        { format: 'pdf', role: 'primary' },
        { format: 'fb2', role: 'content' },
      ],
      'No story guide for this format',
      "Story guides are built from EPUB, KEPUB, MOBI, AZW or AZW3 files. This book has PDF and FB2, which a guide can't be built from.",
    ],
    ['none', [], 'No story guide yet', 'This book has no files a story guide can be built from.'],
  ])('explains the %s case and fetches nothing', async (kind, files, title, body) => {
    const tab = await openTab(files)
    const panel = tab.get('[data-testid=story-guide-tab-unavailable]')
    expect(panel.attributes('data-reason')).toBe(kind)
    expect(panel.get('h2').text()).toBe(title)
    expect(panel.get('p').text()).toBe(body)
    expect(panel.findAll('button')).toHaveLength(0)
    expect(getStoryGuideStatus).not.toHaveBeenCalled()
    expect(fetchStoryGuide).not.toHaveBeenCalled()
    expect(fetchStoryRecap).not.toHaveBeenCalled()
  })
})

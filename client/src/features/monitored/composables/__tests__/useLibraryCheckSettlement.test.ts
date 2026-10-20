import { expect, it, vi } from 'vitest'
import { useLibraryCheckSettlement } from '../useLibraryCheckSettlement'

it('rechecks after a terminal event arrives during an older fetching response', async () => {
  let checking = true
  let resolve!: () => void
  const fetchDetail = vi
    .fn<() => Promise<'fetching' | 'idle'>>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = () => done('fetching')
        }),
    )
    .mockResolvedValue('idle')
  const attempt = vi.fn<(id: string) => Promise<void>>(async () => {
    if ((await fetchDetail()) === 'idle') checking = false
  })
  const settle = useLibraryCheckSettlement(() => checking, attempt)
  const pending = settle('a')
  await settle('a')
  resolve()
  await pending
  expect(fetchDetail).toHaveBeenCalledTimes(2)
  expect(checking).toBe(false)
})

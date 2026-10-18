import { describe, expect, it } from 'vitest'
import { readSseEvents } from './sse'

interface RecordedEvent {
  event: string | undefined
  data: unknown
}

/** A response whose body hands over exactly these chunks, in order, so boundaries land mid-message. */
function chunkedResponse(chunks: string[]): Response {
  let index = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++]) } : { done: true, value: undefined },
      }),
    },
  } as unknown as Response
}

function textResponse(text: string): Response {
  return { ok: true, status: 200, body: undefined, text: async () => text } as unknown as Response
}

async function read(res: Response): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = []
  await readSseEvents(res, (event, data) => events.push({ event, data }))
  return events
}

describe('readSseEvents', () => {
  it('reads the event name and the parsed data of each message', async () => {
    const events = await read(textResponse('event: progress\ndata: {"count":1}\n\nevent: result\ndata: {"count":2}\n\n'))

    expect(events).toEqual([
      { event: 'progress', data: { count: 1 } },
      { event: 'result', data: { count: 2 } },
    ])
  })

  it('buffers a message split across chunk boundaries', async () => {
    const events = await read(chunkedResponse(['event: prog', 'ress\nda', 'ta: {"a":1}', '\n\nevent: result\ndata: {"b":2}\n\n']))

    expect(events).toEqual([
      { event: 'progress', data: { a: 1 } },
      { event: 'result', data: { b: 2 } },
    ])
  })

  it('reads a final message whose stream ends without a trailing blank line', async () => {
    const events = await read(chunkedResponse(['event: result\ndata: {"done":true}\n\n', 'event: progress\ndata: {"late":true}\n']))

    expect(events).toEqual([
      { event: 'result', data: { done: true } },
      { event: 'progress', data: { late: true } },
    ])
  })

  it('skips a message whose data is not JSON without dropping the ones around it', async () => {
    const events = await read(textResponse('event: progress\ndata: {broken json}\n\nevent: result\ndata: {"ok":true}\n\n'))

    expect(events).toEqual([{ event: 'result', data: { ok: true } }])
  })

  it('skips a message with no data line and reports no event name where none was stated', async () => {
    const events = await read(textResponse('event: ping\n\ndata: {"anonymous":true}\n\n: comment only\n\n'))

    expect(events).toEqual([{ event: undefined, data: { anonymous: true } }])
  })

  it('lets a handler that throws reach the caller instead of being swallowed', async () => {
    const handler = (event: string | undefined): void => {
      if (event === 'error') throw new Error('handler blew up')
    }

    await expect(
      readSseEvents(textResponse('event: error\ndata: {"message":"boom"}\n\nevent: result\ndata: {"ok":true}\n\n'), handler),
    ).rejects.toThrow('handler blew up')
  })
})

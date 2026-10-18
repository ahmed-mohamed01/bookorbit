/**
 * Reads a `text/event-stream` response and hands each complete message to `onEvent` as a parsed
 * JSON payload. Chunks rarely align with messages, so partial input is buffered until a blank line
 * ends the message it belongs to. A message whose data is not valid JSON is skipped rather than
 * allowed to break a stream that is otherwise still flowing.
 */
export async function readSseEvents(res: Response, onEvent: (event: string | undefined, data: unknown) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''

  const consume = (chunk: string): void => {
    buffer += chunk
    const messages = buffer.split(/\r?\n\r?\n/)
    buffer = messages.pop() ?? ''
    for (const message of messages) emit(message, onEvent)
  }

  if (res.body) {
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      consume(decoder.decode(value, { stream: true }))
    }
    consume(decoder.decode())
  } else {
    // Not every caller streams: a response handed over as a whole body still parses the same way.
    consume(await res.text())
  }
  // A well-formed stream ends every message with a blank line, but a cut-short one is still read.
  if (buffer) emit(buffer, onEvent)
}

function emit(message: string, onEvent: (event: string | undefined, data: unknown) => void): void {
  let event: string | undefined
  const data: string[] = []
  for (const rawLine of message.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim())
  }
  if (data.length === 0) return
  let payload: unknown
  try {
    payload = JSON.parse(data.join('\n'))
  } catch {
    return
  }
  // Outside the parse guard: a handler that throws, such as on an error event, must reach the caller.
  onEvent(event, payload)
}

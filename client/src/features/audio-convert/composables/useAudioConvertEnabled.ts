// Fork: Convert to M4B. Whether the tool is switched on and the admin's saved encoder defaults,
// shared by the Tools header, the Tools view and the book page.
import { ref } from 'vue'
import type { AudioConvertEncoderOptions } from '@bookorbit/types'

import * as audioConvertApi from '../api/audio-convert'

/** `null` until a definite answer. Shared module state, so every caller sees one request. */
const enabled = ref<boolean | null>(null)
/** Saved codec, bitrate and channels; `null` until the first answer. */
const encoder = ref<AudioConvertEncoderOptions | null>(null)
let pending: Promise<void> | null = null

function load(force = false): Promise<void> {
  if (pending) return pending
  if (!force && enabled.value !== null) return Promise.resolve()
  pending = audioConvertApi
    .fetchAudioConvertEnabled()
    .then((result) => {
      enabled.value = result.enabled === true
      encoder.value = result.encoder ?? null
    })
    .catch((e: unknown) => {
      // Only a server without the fork module (404) means "off". Anything else leaves the answer
      // unknown, so the next caller asks again instead of hiding the tool until a reload.
      if (e instanceof audioConvertApi.AudioConvertHttpError && e.status === 404) enabled.value = false
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Settings updates the cache on save so the Tools tab and the dialogs follow without a reload. */
function setState(value: boolean, options?: AudioConvertEncoderOptions): void {
  enabled.value = value
  if (options) encoder.value = { codec: options.codec, bitrate: options.bitrate, channels: options.channels }
}

/** Test seam: forget the cached answer. */
export function resetAudioConvertEnabled(): void {
  enabled.value = null
  encoder.value = null
  pending = null
}

export function useAudioConvertEnabled(options: { autoload?: boolean } = {}) {
  if (options.autoload !== false && enabled.value === null) void load()
  return { enabled, encoder, load, setState }
}

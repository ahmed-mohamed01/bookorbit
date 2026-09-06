// Movement classifier for the alignment sync's "actively reading" gate. Positions from both sides
// arrive canonicalized to audio-equivalent seconds, so one physical rule covers ebook and audiobook
// alike: a position change is gradual when it is achievable at real listening/reading pace since the
// previous event; anything faster is a seek. A seek is not trusted immediately - it is quarantined
// until activity continues from the new spot for JUMP_CONFIRM_MS, so an accidental scrub or scroll
// that is abandoned (or undone) never projects onto the counterpart. Absence earns no extra trust:
// the forward credit a single gap can grant is capped, so a huge jump hours later still quarantines.

export interface MovementState {
  acceptedPosSeconds: number;
  acceptedAtMs: number;
  pending?: { startPosSeconds: number; firstAtMs: number; lastPosSeconds: number; lastAtMs: number };
}

export interface MovementDecision {
  accept: boolean;
  state: MovementState;
}

// Fastest believable sustained pace versus wall clock (speed listeners run up to ~3.5x).
export const MAX_ADVANCE_RATE = 4;
// Absorbs coarse update cadences (a source that reports every few minutes) and modest clock skew.
export const RATE_SLACK_SECONDS = 180;
// Rewinding a little to re-hear or re-read is normal engagement, not a seek.
export const BACKWARD_SLACK_SECONDS = 180;
// A jump only becomes the new truth after activity continues from it for this long.
export const JUMP_CONFIRM_MS = 2 * 60_000;
// Continuation from a pending jump earns full-rate credit only for a short active window; beyond it
// the credit accrues at a sustained pace instead. Real long-horizon reading (even binges) fits under
// a sustained rate, while a second unrelated seek shortly after the first no longer masquerades as
// continuation just because hours passed.
export const SUSTAINED_ADVANCE_RATE = 1.5;
// Caps how much forward credit one gap can earn. Without it, any jump after a long absence would
// count as gradual. Genuine long offline sessions beyond the cap confirm via the quarantine path.
export const MAX_ELAPSED_CREDIT_SECONDS = 30 * 60;

function isGradual(fromPosSeconds: number, fromAtMs: number, toPosSeconds: number, toAtMs: number, mode: 'baseline' | 'continuation'): boolean {
  const elapsedSeconds = Math.max(0, (toAtMs - fromAtMs) / 1000);
  const activeSeconds = Math.min(MAX_ELAPSED_CREDIT_SECONDS, elapsedSeconds);
  const sustainedSeconds = mode === 'continuation' ? Math.max(0, elapsedSeconds - MAX_ELAPSED_CREDIT_SECONDS) : 0;
  const credit = activeSeconds * MAX_ADVANCE_RATE + sustainedSeconds * SUSTAINED_ADVANCE_RATE + RATE_SLACK_SECONDS;
  const delta = toPosSeconds - fromPosSeconds;
  if (delta < 0) return -delta <= BACKWARD_SLACK_SECONDS;
  return delta <= credit;
}

export function classifyMovement(state: MovementState | undefined, posSeconds: number, atMs: number): MovementDecision {
  // No history (fresh pair, or first event after a restart): trust it and start tracking.
  if (!state) {
    return { accept: true, state: { acceptedPosSeconds: posSeconds, acceptedAtMs: atMs } };
  }

  const pending = state.pending;
  if (pending) {
    // Continuation FROM a pending jump uses the sustained-rate budget: a source that reports once
    // per session (Kobo/KOReader) delivers its next event a day later, and that event both continues
    // and confirms the previous sync's jump - while a second unrelated seek exceeds even sustained
    // pace and supersedes the pending jump below instead.
    if (isGradual(pending.lastPosSeconds, pending.lastAtMs, posSeconds, atMs, 'continuation')) {
      if (atMs - pending.firstAtMs >= JUMP_CONFIRM_MS) {
        return { accept: true, state: { acceptedPosSeconds: posSeconds, acceptedAtMs: atMs } };
      }
      return { accept: false, state: { ...state, pending: { ...pending, lastPosSeconds: posSeconds, lastAtMs: atMs } } };
    }
    if (isGradual(state.acceptedPosSeconds, state.acceptedAtMs, posSeconds, atMs, 'baseline')) {
      // Back near the last accepted position: the jump was undone, resume normal tracking.
      return { accept: true, state: { acceptedPosSeconds: posSeconds, acceptedAtMs: atMs } };
    }
    // A different jump supersedes the quarantined one and restarts its confirmation clock.
    return {
      accept: false,
      state: { ...state, pending: { startPosSeconds: posSeconds, firstAtMs: atMs, lastPosSeconds: posSeconds, lastAtMs: atMs } },
    };
  }

  if (isGradual(state.acceptedPosSeconds, state.acceptedAtMs, posSeconds, atMs, 'baseline')) {
    return { accept: true, state: { acceptedPosSeconds: posSeconds, acceptedAtMs: atMs } };
  }
  return {
    accept: false,
    state: {
      acceptedPosSeconds: state.acceptedPosSeconds,
      acceptedAtMs: state.acceptedAtMs,
      pending: { startPosSeconds: posSeconds, firstAtMs: atMs, lastPosSeconds: posSeconds, lastAtMs: atMs },
    },
  };
}

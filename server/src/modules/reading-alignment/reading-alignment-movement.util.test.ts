import { classifyMovement, type MovementState } from './reading-alignment-movement.util';

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;

function accepted(posSeconds: number, atSeconds: number): MovementState {
  return { acceptedPosSeconds: posSeconds, acceptedAtMs: at(atSeconds) };
}

describe('classifyMovement', () => {
  it('accepts the first event when there is no history', () => {
    const decision = classifyMovement(undefined, 5000, at(0));
    expect(decision.accept).toBe(true);
    expect(decision.state).toEqual({ acceptedPosSeconds: 5000, acceptedAtMs: at(0) });
  });

  it('accepts a gradual forward advance', () => {
    const decision = classifyMovement(accepted(100, 0), 160, at(30));
    expect(decision.accept).toBe(true);
    expect(decision.state.acceptedPosSeconds).toBe(160);
    expect(decision.state.pending).toBeUndefined();
  });

  it('accepts a small rewind within the backward slack', () => {
    const decision = classifyMovement(accepted(500, 0), 400, at(10));
    expect(decision.accept).toBe(true);
  });

  it('accepts a plausible advance after a long gap, up to the elapsed-credit cap', () => {
    const decision = classifyMovement(accepted(100, 0), 3000, at(20 * 3600));
    expect(decision.accept).toBe(true);
  });

  it('keeps a sparse once-a-day source syncing: each event confirms the previous pending jump', () => {
    // A device that syncs once per day while the user reads ~3h of book per day. Every event exceeds
    // the capped baseline credit, but the NEXT day's event continues gradually from the pending jump
    // (uncapped elapsed) and is past the confirmation window - so the source syncs on alternating
    // events instead of dying entirely.
    let state: ReturnType<typeof classifyMovement>['state'] | undefined = undefined;
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const decision = classifyMovement(state, i * 10_800, at(i * 86_400));
      results.push(decision.accept);
      state = decision.state;
    }
    expect(results).toEqual([true, false, true, false, true, false]);
    expect(state?.acceptedPosSeconds).toBe(4 * 10_800);
  });

  it('a second large jump after a short gap supersedes the pending jump instead of confirming it', () => {
    const jumped = classifyMovement(accepted(3600, 0), 9000, at(600)).state;
    const decision = classifyMovement(jumped, 32_400, at(600 + 3600));
    expect(decision.accept).toBe(false);
    expect(decision.state.pending?.startPosSeconds).toBe(32_400);
  });

  it('quarantines a huge jump even after a long gap - absence earns no extra trust', () => {
    const decision = classifyMovement(accepted(100, 0), 30_000, at(20 * 3600));
    expect(decision.accept).toBe(false);
    expect(decision.state.pending?.startPosSeconds).toBe(30_000);
  });

  it('quarantines a sudden forward jump without moving the accepted position', () => {
    const decision = classifyMovement(accepted(160, 30), 5000, at(60));
    expect(decision.accept).toBe(false);
    expect(decision.state.acceptedPosSeconds).toBe(160);
    expect(decision.state.pending).toEqual({ startPosSeconds: 5000, firstAtMs: at(60), lastPosSeconds: 5000, lastAtMs: at(60) });
  });

  it('quarantines a large backward jump', () => {
    const decision = classifyMovement(accepted(5000, 0), 100, at(30));
    expect(decision.accept).toBe(false);
    expect(decision.state.pending?.startPosSeconds).toBe(100);
  });

  it('keeps holding a jump while activity continues but the confirmation window has not elapsed', () => {
    const jumped = classifyMovement(accepted(160, 30), 5000, at(60)).state;
    const decision = classifyMovement(jumped, 5060, at(90));
    expect(decision.accept).toBe(false);
    expect(decision.state.pending).toEqual({ startPosSeconds: 5000, firstAtMs: at(60), lastPosSeconds: 5060, lastAtMs: at(90) });
  });

  it('accepts a jump once activity continues from it past the confirmation window', () => {
    let state = classifyMovement(accepted(160, 30), 5000, at(60)).state;
    state = classifyMovement(state, 5060, at(90)).state;
    const decision = classifyMovement(state, 5400, at(200));
    expect(decision.accept).toBe(true);
    expect(decision.state).toEqual({ acceptedPosSeconds: 5400, acceptedAtMs: at(200) });
  });

  it('resumes normal tracking when an abandoned jump returns to the accepted position', () => {
    const jumped = classifyMovement(accepted(160, 30), 5000, at(60)).state;
    const decision = classifyMovement(jumped, 200, at(90));
    expect(decision.accept).toBe(true);
    expect(decision.state.acceptedPosSeconds).toBe(200);
    expect(decision.state.pending).toBeUndefined();
  });

  it('replaces a quarantined jump with a newer unrelated jump and restarts its clock', () => {
    const jumped = classifyMovement(accepted(160, 30), 5000, at(60)).state;
    const decision = classifyMovement(jumped, 9000, at(90));
    expect(decision.accept).toBe(false);
    expect(decision.state.pending).toEqual({ startPosSeconds: 9000, firstAtMs: at(90), lastPosSeconds: 9000, lastAtMs: at(90) });
  });

  it('does not confirm a jump merely because time passed without activity from it', () => {
    const jumped = classifyMovement(accepted(160, 30), 5000, at(60)).state;
    // Hours later the user reads near the OLD position: the stale pending jump must not win.
    const decision = classifyMovement(jumped, 300, at(4 * 3600));
    expect(decision.accept).toBe(true);
    expect(decision.state.acceptedPosSeconds).toBe(300);
    expect(decision.state.pending).toBeUndefined();
  });
});

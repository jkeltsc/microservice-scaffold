// Feature: api-dev-server, Property 3: Restart gating over arbitrary event interleavings
//
// The two-watcher race (Requirement 5) is solved by making the restart decision
// a total, pure function `decide` over a typed `DevEvent` stream. This suite
// exercises that totality: it generates arbitrary `DevEvent` sequences —
// INCLUDING physically impossible orderings the real shell could never produce
// (a `compile-complete` with no preceding `compile-start`, an `overseer-exited`
// with no child, a stray `overseer-ready`) — and asserts the gating invariants
// hold for every reachable state regardless of ordering. The point is not that
// the shell emits these orderings; it is that `decide` never violates an
// invariant no matter what it is fed, so the invariants are properties of the
// function rather than of the shell's discipline.
//
// The invariants asserted (each traceable to the design's "4b" rules table):
//  - the live-child counter never exceeds 1 (R5.7);
//  - every `start-overseer` is emitted from phase `none` (or from `stopping` on
//    the exit that consumes a pending restart) and carries the then-current
//    `generation`, which a zero-error pass advances — either because it emitted,
//    or because it is the session's first clean pass over an already complete
//    tree (the warm-tree case) — so the executed output is always a
//    Last_Good_Output (R4.8, R5.1, R6.6);
//  - a clean non-emitting `compile-complete` from phase `none` with no gate and
//    no Last_Good_Output yet is the warm-tree initial start (exactly one start);
//    the same event while `running` is a no-op, and while gated the gate stays
//    (R4.5, R4.7, R4.8, R6.5);
//  - no start/stop action appears between a `compile-start` and its
//    `compile-complete`: while a pass is in progress the running child keeps
//    serving the Last_Good_Output (R5.2, R5.3, R5.5);
//  - no `start-overseer` follows an erroring `compile-complete` without an
//    intervening clean pass (R6.2), and no start follows a spontaneous
//    exit without an intervening clean *emitting* pass that lifts the gate
//    (R4.7, R6.5);
//  - a `signal` yields exactly `stop-overseer` then `stop-watcher` (plus its
//    log), and nothing after `terminating` (R1.6);
//  - exactly one completion log per `compile-complete` (R5.8) and exactly one
//    restart record per `overseer-ready` that finds a starting child (R4.6).
//
// Validates: Requirements 1.6, 2.6, 4.2, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.2, 6.5, 6.6, 7.1, 7.3

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  decide,
  initialDevState,
  reduceDevEvents,
  type DevAction,
  type DevEvent,
  type DevState,
} from "../src/dev-supervisor.js";

// ---------------------------------------------------------------------------
// Event generator — deliberately unconstrained
// ---------------------------------------------------------------------------
//
// Each event kind is generated independently of the current state, so the
// resulting sequences include orderings the real shell could never emit. That
// is the whole point: totality is only meaningfully exercised when `decide` is
// fed impossible histories.

const arbDevEvent: fc.Arbitrary<DevEvent> = fc.oneof(
  fc.constant<DevEvent>({ kind: "file-change" }),
  fc.constant<DevEvent>({ kind: "compile-start" }),
  fc.record({
    kind: fc.constant("compile-complete" as const),
    errorCount: fc.nat({ max: 5 }),
    emitted: fc.boolean(),
  }),
  fc.constant<DevEvent>({ kind: "overseer-ready" }),
  fc.record({
    kind: fc.constant("overseer-exited" as const),
    status: fc.oneof(fc.constant(null), fc.integer({ min: -1, max: 255 })),
  }),
  fc.record({
    kind: fc.constant("signal" as const),
    signal: fc.constantFrom("SIGINT" as const, "SIGTERM" as const),
  }),
);

const arbEventSequence: fc.Arbitrary<DevEvent[]> = fc.array(arbDevEvent, {
  minLength: 0,
  maxLength: 40,
});

// A generator that biases toward reaching the interesting phases (a live child,
// a stopping child, a pending restart) by making the "physically plausible"
// events more frequent, so the property does not spend most of its runs on
// no-op events against phase `none`.
const arbPlausibleEvent: fc.Arbitrary<DevEvent> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<DevEvent>({ kind: "compile-start" }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("compile-complete" as const),
      errorCount: fc.oneof(
        { weight: 3, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 5 }) },
      ),
      emitted: fc.boolean(),
    }),
  },
  { weight: 2, arbitrary: fc.constant<DevEvent>({ kind: "overseer-ready" }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("overseer-exited" as const),
      status: fc.oneof(fc.constant(null), fc.integer({ min: -1, max: 255 })),
    }),
  },
  { weight: 1, arbitrary: fc.constant<DevEvent>({ kind: "file-change" }) },
);

const arbPlausibleSequence: fc.Arbitrary<DevEvent[]> = fc.array(
  arbPlausibleEvent,
  { minLength: 0, maxLength: 60 },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHILD_PHASES: ReadonlySet<DevState["overseer"]> = new Set([
  "starting",
  "running",
  "stopping",
]);

function childCount(state: DevState): number {
  return CHILD_PHASES.has(state.overseer) ? 1 : 0;
}

function isStart(a: DevAction): a is Extract<DevAction, { kind: "start-overseer" }> {
  return a.kind === "start-overseer";
}

function isStop(a: DevAction): boolean {
  return a.kind === "stop-overseer";
}

function isCompletionLog(a: DevAction): boolean {
  return (
    a.kind === "log" &&
    a.stream === "stdout" &&
    a.message.startsWith("[dev:compile] cycle complete:")
  );
}

function isRestartRecord(a: DevAction): boolean {
  return (
    a.kind === "log" &&
    a.stream === "stdout" &&
    a.message === "[dev] Overseer restarted"
  );
}

/**
 * A single fold that walks every step of a sequence, checking per-step
 * invariants and accumulating counts. Sharing one walk keeps the assertions
 * consistent and lets each property look only at the aggregate it cares about.
 */
interface Walk {
  /** The maximum live-child count observed across all steps. */
  maxLiveChildren: number;
  /** Every `start-overseer` action, paired with the phase it was emitted from,
   *  the event kind that triggered it, the state's generation, and enough of
   *  the triggering `compile-complete` (when the start was pass-driven) to
   *  classify it as a warm-tree initial start, a replacement of a running
   *  child, or a crash-gate lift. */
  starts: {
    generation: number;
    fromPhase: DevState["overseer"];
    triggerKind: DevEvent["kind"];
    stateGeneration: number;
    /** The `emitted` flag of the triggering event, when it was a
     *  `compile-complete`; null for exit-driven starts. */
    triggerEmitted: boolean | null;
    /** True when `awaitingCleanPass` was set on entry to the start step, i.e.
     *  the start lifted a crash gate. */
    liftedGate: boolean;
  }[];
  /** Count of `compile-complete` events and the completion logs they produced. */
  compileCompletes: number;
  completionLogs: number;
  /** Count of `overseer-ready` events that found a starting child, and the
   *  restart records produced. */
  readyIntoStarting: number;
  restartRecords: number;
  /** True if any start ever appeared while awaitingCleanPass was set on entry. */
  startWhileAwaitingCleanPass: boolean;
  /** True if a start/stop action ever appeared on a `compile-start` /
   *  `file-change` step (i.e. while entering/continuing a pass). */
  startStopDuringPassEvent: boolean;
  final: DevState;
}

function walk(events: readonly DevEvent[]): Walk {
  let state = initialDevState;
  let liveChildren = 0;
  let maxLiveChildren = 0;
  const starts: Walk["starts"] = [];
  let compileCompletes = 0;
  let completionLogs = 0;
  let readyIntoStarting = 0;
  let restartRecords = 0;
  let startWhileAwaitingCleanPass = false;
  let startStopDuringPassEvent = false;

  for (const event of events) {
    const before = state;
    const { state: after, actions } = decide(before, event);

    const startActions = actions.filter(isStart);
    const stopActions = actions.filter(isStop);

    // Record the emitting phase for the aggregate assertion below. A
    // `start-overseer` is emitted in exactly two situations, both of which
    // leave at most one child alive:
    //   - from phase `none` on a clean emitting pass (no child existed), or
    //   - from phase `stopping` on the `overseer-exited` that clears a pending
    //     restart — the outgoing child has just exited in this same event, so
    //     no child overlaps the replacement.
    for (const s of startActions) {
      starts.push({
        generation: s.generation,
        fromPhase: before.overseer,
        triggerKind: event.kind,
        stateGeneration: after.generation,
        triggerEmitted:
          event.kind === "compile-complete" ? event.emitted : null,
        liftedGate: before.awaitingCleanPass,
      });
      // Blocked-restart gate: a start must never appear while the previous
      // child died on its own / failed to bind and no clean pass has since
      // lifted the gate (R4.7, R6.5).
      if (before.awaitingCleanPass) {
        startWhileAwaitingCleanPass = true;
      }
      liveChildren += 1;
    }

    // A child leaves the world exactly when an `overseer-exited` moves the phase
    // out of a child phase into `none` without an immediate replacement start.
    if (event.kind === "overseer-exited" && childCount(before) === 1) {
      // The child that exited is gone; a replacement start (if any) was already
      // counted above via startActions.
      liveChildren -= 1;
    }

    maxLiveChildren = Math.max(maxLiveChildren, liveChildren, childCount(after));

    // No start/stop between a compile-start and its compile-complete: the
    // pass-entry events themselves must never move the child (R5.2, R5.3).
    if (event.kind === "compile-start" || event.kind === "file-change") {
      if (startActions.length > 0 || stopActions.length > 0) {
        startStopDuringPassEvent = true;
      }
    }

    // Completion logs and restart records are only expected for events the
    // decision core actually processes. Once `terminating` is set every event
    // is a no-op (R1.6), so a compile-complete or overseer-ready arriving after
    // a signal produces nothing — and must not be counted as an obligation.
    if (event.kind === "compile-complete" && !before.terminating) {
      compileCompletes += 1;
      completionLogs += actions.filter(isCompletionLog).length;
    }

    if (event.kind === "overseer-ready" && !before.terminating) {
      if (before.overseer === "starting") readyIntoStarting += 1;
      restartRecords += actions.filter(isRestartRecord).length;
    }

    state = after;
  }

  return {
    maxLiveChildren,
    starts,
    compileCompletes,
    completionLogs,
    readyIntoStarting,
    restartRecords,
    startWhileAwaitingCleanPass,
    startStopDuringPassEvent,
    final: state,
  };
}

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe("Property 3: restart gating over arbitrary event interleavings", () => {
  it("never lets more than one Overseer child be alive at once", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          expect(walk(events).maxLiveChildren).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("emits start-overseer only from phase 'none' carrying the current generation", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          const { starts } = walk(events);
          for (const s of starts) {
            // Emitted from `none` (fresh start) or from `stopping` on the exit
            // that consumes a pending restart (the outgoing child has just
            // exited). Both keep the live-child count at ≤ 1.
            expect(["none", "stopping"]).toContain(s.fromPhase);
            // A start from `stopping` is only ever produced by an
            // `overseer-exited`, never by a pass-entry or clean-pass event.
            if (s.fromPhase === "stopping") {
              expect(s.triggerKind).toBe("overseer-exited");
            }
            // Carries the current generation, which is a positive number (only
            // a zero-error pass advances it — either because it emitted, or
            // because it is the session's first clean pass over an already
            // complete tree — so a start always implies a prior clean pass).
            expect(s.generation).toBeGreaterThanOrEqual(1);
            expect(s.generation).toBe(s.stateGeneration);

            // Every start follows a clean pass. A pass-driven start (from
            // `none`) is triggered by a `compile-complete`; a warm-tree initial
            // start rides a non-emitting one, so a clean pass — not a clean
            // *emitting* pass — is all a start requires in general.
            if (s.triggerKind === "compile-complete") {
              // But `emitted === true` IS additionally required when the start
              // lifts a crash gate — relaunching unchanged failing output is
              // exactly what the gate excludes (R4.7, R6.5).
              if (s.liftedGate) {
                expect(s.triggerEmitted).toBe(true);
              }
            }
            // A start that replaces a *running* child never rides a
            // pass-entry/clean-pass step directly: the running-child clean pass
            // emits `stop-overseer`, and the replacement start is driven later
            // by the `overseer-exited` from phase `stopping`. So a start
            // replacing a running child is always exit-driven, and the clean
            // *emitting* pass that set `restartPending` precedes it — asserted
            // by the pinned worked trace below.
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("performs no start/stop while a Compile_Pass is in progress", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          expect(walk(events).startStopDuringPassEvent).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never starts a replacement while a clean pass has not lifted the awaiting-clean-pass gate", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          // A start is emitted either directly on a clean emitting pass (which
          // clears awaitingCleanPass in the same step, so `before` still has it
          // set only when the pass is the one lifting the gate) or from the
          // stopping-exit path. In neither case is a start ever produced while a
          // spontaneous exit's gate is still in force with no clean pass. The
          // decision core clears the gate on the clean pass that also starts, so
          // `before.awaitingCleanPass` being true on a start step is only
          // possible on that very clean-pass step — never on an exit-driven one.
          //
          // We assert the stronger, unambiguous form: no start is ever emitted
          // from phase `none` while awaitingCleanPass is set AND the triggering
          // event is not a clean emitting compile-complete.
          let bad = false;
          let state: DevState = initialDevState;
          for (const event of events) {
            const before = state;
            const { state: after, actions } = decide(before, event);
            const started = actions.some(isStart);
            if (started && before.awaitingCleanPass) {
              const liftsGate =
                event.kind === "compile-complete" &&
                event.errorCount === 0 &&
                event.emitted;
              if (!liftsGate) bad = true;
            }
            state = after;
          }
          expect(bad).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("yields no replacement Overseer from an unrequested exit", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          // An unrequested exit is an `overseer-exited` while phase is
          // `starting` or `running` (a requested exit is only reachable from
          // `stopping`). Such an exit must emit no start action in the same
          // step and must set awaitingCleanPass.
          let state: DevState = initialDevState;
          for (const event of events) {
            const before = state;
            const { state: after, actions } = decide(before, event);
            if (
              event.kind === "overseer-exited" &&
              !before.terminating &&
              (before.overseer === "starting" || before.overseer === "running")
            ) {
              expect(actions.some(isStart)).toBe(false);
              expect(after.awaitingCleanPass).toBe(true);
              expect(after.overseer).toBe("none");
            }
            state = after;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("starts exactly one Overseer for a warm-tree non-emitting first pass, and nothing for the same event once settled or gated", () => {
    // Sub-part 3i, asserted directly on `decide` at the three states that share
    // the identical `compile-complete` event shape — the regression the
    // emit-gated rule got wrong. The distinguishing state is `hasLastGood` /
    // `awaitingCleanPass`, never the event, so the assertion is stated over the
    // entry state.
    const warmPass: DevEvent = {
      kind: "compile-complete",
      errorCount: 0,
      emitted: false,
    };

    // From phase `none`, hasLastGood === false, no gate: the warm-tree initial
    // start — exactly one `start-overseer` at generation 1 (R4.8, R5.1).
    const fromNone = decide(initialDevState, warmPass);
    const fromNoneStarts = fromNone.actions.filter(isStart);
    expect(fromNoneStarts).toHaveLength(1);
    expect(fromNoneStarts[0].generation).toBe(1);
    expect(fromNone.actions.filter(isStop)).toHaveLength(0);
    expect(fromNone.state.overseer).toBe("starting");
    expect(fromNone.state.generation).toBe(1);
    expect(fromNone.state.hasLastGood).toBe(true);

    // From phase `running` (a settled session): a no-op pass — no start and no
    // stop, the live child stays in place (R4.5, R5.6).
    const running: DevState = {
      ...initialDevState,
      overseer: "running",
      generation: 1,
      runningGeneration: 1,
      hasLastGood: true,
    };
    const fromRunning = decide(running, warmPass);
    expect(fromRunning.actions.filter(isStart)).toHaveLength(0);
    expect(fromRunning.actions.filter(isStop)).toHaveLength(0);
    expect(fromRunning.state.overseer).toBe("running");
    expect(fromRunning.state.generation).toBe(1);

    // From phase `none` with the crash gate in force: the gate stays — no
    // start, `generation` unadvanced, `awaitingCleanPass` still set. Relaunching
    // the same unchanged output that just failed is exactly what is excluded
    // (R4.7, R6.5).
    const gated: DevState = {
      ...initialDevState,
      overseer: "none",
      generation: 1,
      hasLastGood: true,
      awaitingCleanPass: true,
    };
    const fromGated = decide(gated, warmPass);
    expect(fromGated.actions.filter(isStart)).toHaveLength(0);
    expect(fromGated.actions.filter(isStop)).toHaveLength(0);
    expect(fromGated.state.overseer).toBe("none");
    expect(fromGated.state.generation).toBe(1);
    expect(fromGated.state.awaitingCleanPass).toBe(true);
  });

  it("logs exactly one completion per compile-complete", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          const w = walk(events);
          expect(w.completionLogs).toBe(w.compileCompletes);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("records exactly one restart per overseer-ready that finds a starting child", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          const w = walk(events);
          expect(w.restartRecords).toBe(w.readyIntoStarting);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("responds to a signal with stop-overseer (if a child exists) then stop-watcher, and nothing after", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          let state: DevState = initialDevState;
          let terminated = false;
          for (const event of events) {
            const before = state;
            const { state: after, actions } = decide(before, event);

            if (terminated) {
              // Once terminating, every subsequent event is a no-op.
              expect(actions).toEqual([]);
              expect(after).toEqual(before);
            }

            if (event.kind === "signal" && !terminated) {
              const controlActions = actions.filter(
                (a) => a.kind !== "log",
              );
              const hadChild = CHILD_PHASES.has(before.overseer);
              if (hadChild) {
                expect(controlActions).toEqual([
                  { kind: "stop-overseer" },
                  { kind: "stop-watcher" },
                ]);
              } else {
                expect(controlActions).toEqual([{ kind: "stop-watcher" }]);
              }
              expect(after.terminating).toBe(true);
              terminated = true;
            }
            state = after;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Pinned worked example (design "Event stream to action trace")
// ---------------------------------------------------------------------------
//
// A concrete interleaving check: one edit, a second edit arriving mid-compile,
// an erroring pass that leaves the child in place, then a clean pass that
// restarts, then a signal. Exactly one restart results from the burst and no
// restart is derived from the erroring pass.

describe("Property 3 (pinned): the design's worked event trace", () => {
  it("produces exactly one restart across a burst with an intervening error", () => {
    const events: DevEvent[] = [
      { kind: "compile-start" },
      { kind: "compile-complete", errorCount: 0, emitted: true }, // generation 1, start(1)
      { kind: "overseer-ready" }, // restart record
      { kind: "file-change" },
      { kind: "compile-start" },
      { kind: "file-change" }, // coalesced
      { kind: "compile-complete", errorCount: 2, emitted: false }, // child untouched
      { kind: "compile-start" },
      { kind: "compile-complete", errorCount: 0, emitted: true }, // generation 2, stop, restartPending
      { kind: "overseer-exited", status: null }, // start(2)
      { kind: "overseer-ready" }, // restart record
      { kind: "signal", signal: "SIGINT" }, // stop, stop-watcher
    ];

    const w = walk(events);

    expect(w.maxLiveChildren).toBe(1);
    // Two start actions in total: the initial start from `none` at generation 1,
    // and the restart at generation 2, emitted from `stopping` on the
    // `overseer-exited` that consumes the pending restart.
    expect(w.starts.map((s) => s.generation)).toEqual([1, 2]);
    expect(w.starts.map((s) => s.fromPhase)).toEqual(["none", "stopping"]);
    expect(w.starts[1].triggerKind).toBe("overseer-exited");
    // One completion log per compile-complete (three here).
    expect(w.compileCompletes).toBe(3);
    expect(w.completionLogs).toBe(3);
    // Two ready-into-starting, two restart records.
    expect(w.readyIntoStarting).toBe(2);
    expect(w.restartRecords).toBe(2);
    expect(w.final.terminating).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 4: A no-op Compile_Pass is restart-idempotent
// ---------------------------------------------------------------------------
//
// Feature: api-dev-server, Property 4: A no-op Compile_Pass is restart-idempotent
//
// Requirement 4.5 keeps the running Overseer in place when a clean Compile_Pass
// leaves the Compiled_Tree unchanged (emitted === false), and Requirement 5.4
// coalesces a burst of edits into at most one Overseer_Restart, reached once
// Settled_Compilation is reached, with no debounce timer. Restated over the
// pure decision core:
//
//   - For any sequence whose `compile-complete`s AFTER the first clean emitting
//     pass all have `emitted === false` (interleaved freely with file-change,
//     compile-start, overseer-ready and erroring passes, but with no second
//     clean emitting pass and no overseer-exited to disturb the child), the
//     trace contains EXACTLY ONE `start-overseer`: the one the first clean
//     emitting pass produced. Every subsequent no-op / erroring pass is
//     restart-idempotent.
//
//   - For ANY settled burst — a maximal run of pass events whose only clean
//     emitting `compile-complete` is its last — AT MOST ONE `start-overseer`
//     results. Equivalently, over any event sequence the number of
//     `start-overseer` actions never exceeds the number of clean Compile_Passes
//     (`errorCount === 0`, regardless of whether they emitted), the design's
//     `|starts| ≤ |cleanPasses|` bound. The bound is over clean passes rather
//     than clean *emitting* passes because a warm-tree session's single start
//     comes from a clean pass that emitted nothing (design "Property 4").
//
// Validates: Requirements 4.5, 4.8, 5.4

/** A clean emitting pass advances a generation and can restart a live child. */
function isCleanEmittingPass(event: DevEvent): boolean {
  return (
    event.kind === "compile-complete" &&
    event.errorCount === 0 &&
    event.emitted === true
  );
}

/**
 * A clean pass: a zero-error `compile-complete`, whether or not it emitted. This
 * is the quantity the start bound is stated over, because a warm-tree session's
 * single start rides a clean pass that emitted nothing.
 */
function isCleanPass(event: DevEvent): boolean {
  return event.kind === "compile-complete" && event.errorCount === 0;
}

function countStarts(events: readonly DevEvent[]): number {
  return reduceDevEvents(events).actions.filter(isStart).length;
}

function countCleanEmittingPasses(events: readonly DevEvent[]): number {
  return events.filter(isCleanEmittingPass).length;
}

function countCleanPasses(events: readonly DevEvent[]): number {
  return events.filter(isCleanPass).length;
}

describe("Property 4: a no-op Compile_Pass is restart-idempotent", () => {
  // ----- The idempotent-tail construction -----------------------------------
  //
  // A prefix that reaches a live, running child through exactly one clean
  // emitting pass, followed by a tail of events that must NEVER produce a second
  // start: file-change / compile-start (pass entry), clean NON-emitting passes
  // (emitted === false), and erroring passes. No second clean emitting pass and
  // no overseer-exited appear, so the child is never torn down and never gated.
  const arbNoopTailEvent: fc.Arbitrary<DevEvent> = fc.oneof(
    { weight: 2, arbitrary: fc.constant<DevEvent>({ kind: "file-change" }) },
    { weight: 2, arbitrary: fc.constant<DevEvent>({ kind: "compile-start" }) },
    {
      weight: 3,
      arbitrary: fc.constant<DevEvent>({
        kind: "compile-complete",
        errorCount: 0,
        emitted: false,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("compile-complete" as const),
        errorCount: fc.integer({ min: 1, max: 5 }),
        emitted: fc.boolean(),
      }),
    },
    // A stray overseer-ready is harmless: it only ever moves starting → running
    // and logs; it never starts a child.
    { weight: 1, arbitrary: fc.constant<DevEvent>({ kind: "overseer-ready" }) },
  );

  it("starts exactly one Overseer for a warm-tree session and never restarts it thereafter", () => {
    // The warm-tree shape stated explicitly (design "Property 4"): the first
    // clean pass emitted nothing (the tree was already built), and every
    // subsequent clean pass likewise emits nothing. The initial start therefore
    // rides a NON-emitting pass — the shape the emit-gated rule got wrong — and
    // no later pass may restart the child. Built into the generator rather than
    // left to chance, since chance would rarely place a non-emitting clean pass
    // first.
    fc.assert(
      fc.property(
        // Optional leading noise before the warm-tree initial start: pass entry
        // and erroring passes only. No clean pass appears here, so `hasLastGood`
        // is still false when the first clean (non-emitting) pass arrives, which
        // is what makes that pass the warm-tree initial start.
        fc.array(
          fc.oneof(
            fc.constant<DevEvent>({ kind: "file-change" }),
            fc.constant<DevEvent>({ kind: "compile-start" }),
            fc.record({
              kind: fc.constant("compile-complete" as const),
              errorCount: fc.integer({ min: 1, max: 5 }),
              emitted: fc.boolean(),
            }),
          ),
          { minLength: 0, maxLength: 10 },
        ),
        fc.array(arbNoopTailEvent, { minLength: 0, maxLength: 40 }),
        (prefix, tail) => {
          const events: DevEvent[] = [
            ...prefix,
            // The warm-tree initial start: clean, emitted nothing.
            { kind: "compile-complete", errorCount: 0, emitted: false },
            ...tail,
          ];

          // Exactly one start, at generation 1, riding a non-emitting pass.
          expect(countStarts(events)).toBe(1);
          const { state, actions } = reduceDevEvents(events);
          const starts = actions.filter(isStart);
          expect(starts[0].generation).toBe(1);
          // No stop is ever emitted — nothing tears the warm-tree child down.
          expect(actions.some(isStop)).toBe(false);
          // The child settles running-or-starting, generation still 1.
          expect(["starting", "running"]).toContain(state.overseer);
          expect(state.generation).toBe(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("produces exactly one start when every pass after the first clean emitting pass is a no-op or error", () => {
    fc.assert(
      fc.property(
        // Optional leading noise before the first clean emitting pass: pass
        // entry, no-op passes and erroring passes, none of which can start a
        // child (no clean emitting pass has happened yet, so generation is 0).
        fc.array(
          fc.oneof(
            fc.constant<DevEvent>({ kind: "file-change" }),
            fc.constant<DevEvent>({ kind: "compile-start" }),
            fc.constant<DevEvent>({
              kind: "compile-complete",
              errorCount: 0,
              emitted: false,
            }),
            fc.record({
              kind: fc.constant("compile-complete" as const),
              errorCount: fc.integer({ min: 1, max: 5 }),
              emitted: fc.boolean(),
            }),
          ),
          { minLength: 0, maxLength: 10 },
        ),
        fc.array(arbNoopTailEvent, { minLength: 0, maxLength: 40 }),
        (prefix, tail) => {
          // The first clean emitting pass sits between the prefix and the tail,
          // so it is the only generation-advancing event in the whole sequence.
          const events: DevEvent[] = [
            ...prefix,
            { kind: "compile-complete", errorCount: 0, emitted: true },
            ...tail,
          ];

          // Exactly one clean emitting pass, so exactly one start.
          expect(countCleanEmittingPasses(events)).toBe(1);
          expect(countStarts(events)).toBe(1);

          // And the child is never torn down by the tail: it settles into a
          // starting-or-running phase.
          const { state } = reduceDevEvents(events);
          expect(["starting", "running"]).toContain(state.overseer);
        },
      ),
      { numRuns: 300 },
    );
  });

  // ----- A no-op pass never restarts a running Overseer ---------------------
  //
  // Property 4's core claim over arbitrary sequences: at every step where a
  // clean non-emitting `compile-complete` arrives while the child is `running`,
  // that step emits neither a start nor a stop — the live process is left in
  // place (R4.5, R5.6).
  it("emits no start and no stop for a clean non-emitting pass while a child is running", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          let state: DevState = initialDevState;
          for (const event of events) {
            const before = state;
            const { state: after, actions } = decide(before, event);
            if (
              event.kind === "compile-complete" &&
              event.errorCount === 0 &&
              event.emitted === false &&
              before.overseer === "running"
            ) {
              expect(actions.some(isStart)).toBe(false);
              expect(actions.some(isStop)).toBe(false);
              expect(after.overseer).toBe("running");
            }
            state = after;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // ----- The general bound over arbitrary sequences -------------------------
  //
  // Over ANY sequence (including the deliberately impossible interleavings the
  // Property 3 generators produce), the number of start-overseer actions never
  // exceeds the number of clean passes. Each settled burst contributes one clean
  // pass (its settling completion) and drives at most one restart, so this bound
  // is the "at most one restart per settled burst" obligation aggregated over
  // the whole stream. The bound is over clean passes, not clean *emitting*
  // passes: a warm-tree session's single start rides a clean non-emitting pass,
  // so a bound over emitting passes alone would be violated by exactly the
  // regression this amendment fixes.
  it("never emits more start-overseer actions than there are clean passes", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbEventSequence, arbPlausibleSequence),
        (events) => {
          expect(countStarts(events)).toBeLessThanOrEqual(
            countCleanPasses(events),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  // ----- Settled-burst idempotence: a repeated no-op pass restarts once ------
  //
  // A concrete "settled" scenario: after the child is running, an arbitrary
  // number of clean NON-emitting passes (a rebuild that changed nothing) arrive.
  // None of them may restart the child — the session has converged.
  it("keeps the same process across any number of repeated no-op clean passes", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 30 }),
        (noopCount) => {
          const events: DevEvent[] = [
            { kind: "compile-start" },
            { kind: "compile-complete", errorCount: 0, emitted: true }, // start(1)
            { kind: "overseer-ready" }, // running
            ...Array.from({ length: noopCount }, () => [
              { kind: "compile-start" } as DevEvent,
              {
                kind: "compile-complete",
                errorCount: 0,
                emitted: false,
              } as DevEvent,
            ]).flat(),
          ];

          expect(countStarts(events)).toBe(1);
          const { state } = reduceDevEvents(events);
          expect(state.overseer).toBe("running");
          expect(state.generation).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

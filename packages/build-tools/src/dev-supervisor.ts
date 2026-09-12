// This module runs the Overseer locally and restarts it whenever the TypeScript
// sources recompile cleanly. It is the code behind `npm run dev`: scripts/dev.js
// performs the shared startup steps and then spawns the compiled dev-supervisor
// bin, which calls runDevSupervisorCli() at the bottom of this file.
//
// The file has two halves. First a pure decision core: the event, state and action
// types plus `decide`, which maps one state and one event to the next state and the
// effects to perform. Then an effectful shell, runDevSupervisor, which compiles in
// watch mode, owns the Overseer child, and carries out those effects. Keeping the
// decision pure is what lets the restart behaviour be property-tested over
// generated event interleavings without spawning anything.
//
// The dev path runs steps 1-6 of the "Pipeline walkthrough" in the
// package-categories design and consumes the plan's `tsc` roots, nothing else.
// There is no bundler phase — a Spa_Package under development runs its own dev
// server — and nothing is staged: the watcher recompiles each project in place
// and the Overseer runs from its own compiled output.

/**
 * Everything the supervisor can learn about the world. The shell raises these
 * events; `decide` consumes them and nothing else.
 */
export type DevEvent =
  | { readonly kind: "file-change" }
  | { readonly kind: "compile-start" }
  /**
   * A compile pass settled. `emitted` is true when it wrote at least one output
   * file, which the shell records as it writes them.
   */
  | {
      readonly kind: "compile-complete";
      readonly errorCount: number;
      readonly emitted: boolean;
    }
  /** The child logged its "[boot] Overseer listening on port N" line. */
  | { readonly kind: "overseer-ready" }
  /** The child process exited, for any reason. */
  | { readonly kind: "overseer-exited"; readonly status: number | null }
  /** SIGINT / SIGTERM reached the supervisor. */
  | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" };

/** The lifecycle of the single Overseer child the supervisor may own. */
export type OverseerPhase = "none" | "starting" | "running" | "stopping";

/**
 * Everything the supervisor remembers between events. `decide` returns its
 * successor; the shell keeps the latest value and writes no field directly.
 */
export interface DevState {
  /** The child's phase. At most one child exists at a time. */
  readonly overseer: OverseerPhase;
  /** True between a compile-start and its compile-complete. */
  readonly compiling: boolean;
  /**
   * Identifies the compiled output a child was launched from, without inspecting
   * the filesystem. A zero-error pass advances it when it emitted, or when it is
   * the session's first clean pass over an already up-to-date tree (R4.8).
   */
  readonly generation: number;
  /** The generation the live (or starting) child was launched from; null when none. */
  readonly runningGeneration: number | null;
  /** A restart owed once the current child finishes exiting. */
  readonly restartPending: boolean;
  /** Blocks a new child until the next clean pass, after a child died (R4.7, R6.5). */
  readonly awaitingCleanPass: boolean;
  /** True once any clean pass has completed in this session. */
  readonly hasLastGood: boolean;
  /** Set by a signal; the shell stops driving after this. */
  readonly terminating: boolean;
}

/** The only effects the shell may perform, named by the decision. */
export type DevAction =
  | { readonly kind: "start-overseer"; readonly generation: number }
  | { readonly kind: "stop-overseer" }
  | { readonly kind: "stop-watcher" }
  | {
      readonly kind: "log";
      readonly stream: "stdout" | "stderr";
      readonly message: string;
    };

/**
 * The state a session starts in: no child, not compiling, no good output yet.
 * `generation` starts at 0, so the first child ever started carries generation 1.
 */
export const initialDevState: DevState = {
  overseer: "none",
  compiling: false,
  generation: 0,
  runningGeneration: null,
  restartPending: false,
  awaitingCleanPass: false,
  hasLastGood: false,
  terminating: false,
};

function logOut(message: string): DevAction {
  return { kind: "log", stream: "stdout", message };
}

function logErr(message: string): DevAction {
  return { kind: "log", stream: "stderr", message };
}

/**
 * This function decides what happens next. Given the current state and one event, it
 * returns the next state and the effects the shell must perform.
 *
 * It is the entire restart policy: every rule about when the Overseer may start,
 * restart, or stay put is a statement about its output. `dispatch`, inside
 * runDevSupervisor below, calls it once per observed event. Pure and total.
 *
 * Two guarantees fall out of the phase machine rather than being checked anywhere:
 * `start-overseer` is emitted only from phase `none`, so two children are never
 * alive at once (R5.7), and it always carries the current `generation`, so a child
 * only runs output that compiled cleanly (R4.8, R6.6).
 */
export function decide(
  state: DevState,
  event: DevEvent,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  // After a signal, no event produces any further action or state change.
  if (state.terminating) {
    return { state, actions: [] };
  }

  switch (event.kind) {
    // No action either way, so a running child keeps serving the last good output
    // (R5.2, R5.3) — and a burst of edits coalesces with no debounce timer, since
    // only the burst's final `compile-complete` can restart anything (R5.4).
    case "file-change":
    case "compile-start":
      return { state: { ...state, compiling: true }, actions: [] };

    case "compile-complete":
      return decideCompileComplete(state, event);

    // The child bound its HTTP server: starting → running (R4.6).
    case "overseer-ready":
      if (state.overseer === "starting") {
        return {
          state: { ...state, overseer: "running" },
          actions: [logOut("[dev] Overseer restarted")],
        };
      }
      return { state, actions: [] };

    case "overseer-exited":
      return decideOverseerExited(state, event);

    // Stop the child (if any), then the watcher, and stop driving (R1.6).
    case "signal": {
      const actions: DevAction[] = [
        logOut(
          `[dev] received ${event.signal}; stopping the Overseer and the build watcher`,
        ),
      ];
      if (state.overseer !== "none") {
        actions.push({ kind: "stop-overseer" });
      }
      actions.push({ kind: "stop-watcher" });
      return {
        state: { ...state, terminating: true },
        actions,
      };
    }
  }
}

/** This helper decides what a settled compile pass means. Called from `decide`. */
function decideCompileComplete(
  state: DevState,
  event: Extract<DevEvent, { kind: "compile-complete" }>,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  const settled = { ...state, compiling: false };

  // An erroring pass changes nothing but the log; the live child keeps serving the
  // last good output. With no good output yet, say so, so nobody waits for a
  // server that is not coming (R5.8, R6.2, R6.3, R6.6, R6.7).
  if (event.errorCount > 0) {
    const actions: DevAction[] = [
      logOut(
        `[dev:compile] cycle complete: ${event.errorCount} error(s); keeping the running Overseer (last good output)`,
      ),
    ];
    if (!state.hasLastGood) {
      actions.push(
        logOut(
          `[dev] no Overseer started: the first compile pass reported ${event.errorCount} error(s); fix them and the Overseer will start automatically`,
        ),
      );
    }
    return { state: settled, actions };
  }

  const completionLog0 = logOut("[dev:compile] cycle complete: 0 error(s)");

  // A clean pass that emitted nothing, handled three ways. Whether a pass emitted
  // governs restarts only, never whether a session starts at all (R4.8, R5.1).
  if (!event.emitted) {
    // The output on disk is the output that just crashed, so relaunching it would
    // only loop. The gate stays (R4.7, R6.5).
    if (state.awaitingCleanPass) {
      return { state: settled, actions: [completionLog0] };
    }

    // The warm-tree start: nothing to emit means every output was already up to
    // date, so the tree is complete and the first child can start (R4.8, R6.4).
    if (!state.hasLastGood) {
      const generation = state.generation + 1;
      return {
        state: {
          ...settled,
          generation,
          hasLastGood: true,
          overseer: "starting",
          runningGeneration: generation,
          restartPending: false,
        },
        actions: [completionLog0, { kind: "start-overseer", generation }],
      };
    }

    // A no-op pass: a settled session converges to the same child (R4.5, R5.4).
    return { state: settled, actions: [completionLog0] };
  }

  // A clean pass that emitted is new good output: advance the generation, lift the
  // crash gate (R4.7, R6.5), then restart according to the child's phase.
  const generation = state.generation + 1;
  const advanced: DevState = {
    ...settled,
    generation,
    hasLastGood: true,
    awaitingCleanPass: false,
  };

  switch (state.overseer) {
    // Nothing running: start a child on this generation (R4.2, R5.1).
    case "none":
      return {
        state: {
          ...advanced,
          overseer: "starting",
          runningGeneration: generation,
          restartPending: false,
        },
        actions: [completionLog0, { kind: "start-overseer", generation }],
      };

    // A live child: stop it and owe a restart, which the exit handler below then
    // performs, so two children never overlap (R5.7).
    case "running":
      return {
        state: { ...advanced, overseer: "stopping", restartPending: true },
        actions: [completionLog0, { kind: "stop-overseer" }],
      };

    // Mid-start or mid-stop: owe the restart until the child settles (R5.4, R5.7).
    case "starting":
    case "stopping":
      return {
        state: { ...advanced, restartPending: true },
        actions: [completionLog0],
      };
  }
}

/** This helper decides what a child's exit means. Called from `decide`. */
function decideOverseerExited(
  state: DevState,
  event: Extract<DevEvent, { kind: "overseer-exited" }>,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  const status = event.status;

  switch (state.overseer) {
    // A stop we asked for: honour an owed restart, else settle to no child (R5.7).
    case "stopping": {
      if (state.restartPending) {
        return {
          state: {
            ...state,
            overseer: "starting",
            runningGeneration: state.generation,
            restartPending: false,
          },
          actions: [{ kind: "start-overseer", generation: state.generation }],
        };
      }
      return {
        state: { ...state, overseer: "none", runningGeneration: null },
        actions: [],
      };
    }

    // Died before binding: no replacement until the next clean pass (R4.7).
    case "starting":
      return {
        state: {
          ...state,
          overseer: "none",
          runningGeneration: null,
          restartPending: false,
          awaitingCleanPass: true,
        },
        actions: [
          logErr(
            `[dev] Overseer exited with status ${status} before binding; the build watcher is still running, waiting for the next clean compile`,
          ),
        ],
      };

    // A spontaneous exit, handled the same way as a failed bind (R6.5).
    case "running":
      return {
        state: {
          ...state,
          overseer: "none",
          runningGeneration: null,
          restartPending: false,
          awaitingCleanPass: true,
        },
        actions: [
          logErr(
            `[dev] Overseer exited (status ${status}); the build watcher is still running, waiting for the next clean compile`,
          ),
        ],
      };

    case "none":
      return { state, actions: [] };
  }
}

/**
 * This function folds a whole event sequence through `decide` and returns the final
 * state with every action in order. It is what the restart property tests replay
 * generated interleavings through (dev-restart-decision.property.test.ts), and the
 * fold starts from {@link initialDevState} unless a state is given.
 */
export function reduceDevEvents(
  events: Iterable<DevEvent>,
  state: DevState = initialDevState,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  let current = state;
  const actions: DevAction[] = [];
  for (const event of events) {
    const result = decide(current, event);
    current = result.state;
    actions.push(...result.actions);
  }
  return { state: current, actions };
}

// ---------------------------------------------------------------------------
// Which projects the watcher compiles.
//
// The list is not derived here: it IS `buildPlanFrom(...).tscRoots`, the very array
// image-tree.ts hands to the TypeScript build. One derivation, not two that happen
// to agree, so membership, order, determinism and every selector or dependency
// error message are an image build's (R3.6, R3.7, R13.1-R13.11).

import { buildPlanFrom } from "./build-plan.js";
import type { ReadDependencies } from "./required-dependencies.js";
import {
  discoverPackages,
  readDependencySpecifiers,
  type Discovery,
} from "./discovery.js";

/**
 * This function returns the projects to compile, in build order. Each entry is a
 * repo-relative package directory, the form the solution builder wants as a root.
 *
 * Called from {@link devProjectList}, which supplies the real filesystem. Taking
 * the inputs as arguments keeps it pure and testable over in-memory layouts, and
 * taking the whole `Discovery` rather than a directory list means the dev path
 * cannot be handed a different view of the repository than an image build.
 *
 * @param selector the raw `MICROSERVICES` value, passed through unmodified.
 * @param discovery one discovery run's result.
 * @param readDependencies reads a package's `@microservices` dependency names.
 * @throws `[selector:empty]`, `[selector:unmatched]`, `[shared:unresolved]`,
 *   `[deps:peer]`, `[deps:cycle]` — all from the plan, unmodified.
 */
export function projectListFrom(
  selector: string | undefined,
  discovery: Discovery,
  readDependencies: ReadDependencies,
): readonly string[] {
  return buildPlanFrom(selector, discovery, readDependencies).tscRoots;
}

/**
 * This function builds the project list for the real repository and the current
 * `MICROSERVICES` value. Called from {@link runDevSupervisorCli} at startup.
 *
 * Discovery runs once, here; nothing in the steady state lists the microservice
 * directory again (R7.1, R7.3). It reads the environment the way generate-registry.ts
 * does and dependencies through discovery.ts's single reader, so the dev path sees
 * the same microservices as the generated registry.
 */
export function devProjectList(
  selector = process.env.MICROSERVICES,
): readonly string[] {
  return projectListFrom(
    selector,
    discoverPackages(),
    readDependencySpecifiers,
  );
}

// ---------------------------------------------------------------------------
// The effectful shell.
//
// Everything below performs effects and holds no branching policy. It turns the
// solution builder's callbacks and the Overseer child's lifecycle into DevEvents,
// hands each to `decide`, and performs the returned DevActions.
//
// Two things it never does, which is why there is no race to tune around: it never
// observes the compiled output to learn whether a pass wrote anything — that is
// bookkeeping about its own writes — and it runs no debounce timer. The authority on
// "a cycle finished with N errors" is `reportWatchStatus` below, a callback in this
// same event loop (R5.6).

import { spawn, type ChildProcess } from "node:child_process";

import ts from "typescript";

// The compiled Overseer entrypoint the child is spawned from (R4.1, R9.1).
// framework.ts composes it, so that path is declared once (R10.3, R10.5).
import { OVERSEER_ENTRYPOINT } from "./framework.js";

/**
 * The Overseer's own boot line, scanned for in the child's stdout. It is the only
 * bind signal available, because the Overseer carries no dev-specific branch
 * (R9.4). Seeing it raises `overseer-ready`.
 */
const OVERSEER_READY_MARKER = "[boot] Overseer listening on port";

/**
 * The TypeScript watch-status codes the shell reacts to, verified against
 * typescript@5.9.3. 6032 opens a compile cycle; 6193 and 6194 settle one.
 */
const TS_COMPILE_START = 6032;
const TS_COMPILE_COMPLETE_ONE = 6193;
const TS_COMPILE_COMPLETE_MANY = 6194;

/** This function wraps a watcher so closing it also drops it from the set. */
function trackedWatcher(
  watcher: ts.FileWatcher,
  openWatchers: Set<ts.FileWatcher>,
): ts.FileWatcher {
  return {
    close(): void {
      openWatchers.delete(watcher);
      watcher.close();
    },
  };
}

/**
 * This function runs a dev session: it compiles `projectList` in watch mode, owns
 * the Overseer child, and drives what it observes through {@link decide}. Called
 * from {@link runDevSupervisorCli} below, its only caller.
 *
 * It does not return. It installs the watchers and the signal handlers and lets the
 * event loop run the session until SIGINT or SIGTERM closes the watchers and the
 * child exits, whereupon the process exits 0. If the watcher cannot start it throws
 * unframed, for the caller to report.
 *
 * @param projectList the projects to compile, in build order.
 * @param env the session-start environment, passed to every child unmodified
 *   (R8.1, R8.2).
 */
export function runDevSupervisor(
  projectList: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  // The session state, advanced only through `dispatch`.
  let state = initialDevState;

  // The one Overseer child, and a retained stdout tail so the readiness marker is
  // still matched when it arrives split across two chunks.
  let child: ChildProcess | null = null;
  let childStdoutTail = "";

  // Did the current cycle write any output? The wrapped writeFile below sets it and
  // the settled-cycle handler resets it, so it records the shell's own writes as
  // they happen rather than the state of the compiled output.
  let emittedThisCycle = false;

  // Errors seen in the current cycle, tallied from the diagnostics TypeScript
  // reports. Needed because the count the solution builder passes to the watch-status
  // reporter arrives as 0 even when a project failed, and trusting it would start the
  // Overseer against a tree that did not compile (R5.1, R6.2).
  let errorsThisCycle = 0;

  // Every file watcher the builder's host opened. The builder exposes no close(),
  // so the shell wraps the host's two watch entry points to collect them.
  const openWatchers = new Set<ts.FileWatcher>();

  /** Perform one action. No policy here — the core already decided. */
  function perform(action: DevAction): void {
    switch (action.kind) {
      case "log": {
        const stream =
          action.stream === "stderr" ? process.stderr : process.stdout;
        stream.write(`${action.message}\n`);
        return;
      }
      case "start-overseer":
        startOverseer();
        return;
      case "stop-overseer":
        stopOverseer();
        return;
      case "stop-watcher":
        stopWatcher();
        return;
    }
  }

  /** Feed one event through the core, commit the state, perform the actions. */
  function dispatch(event: DevEvent): void {
    const result = decide(state, event);
    state = result.state;
    for (const action of result.actions) {
      perform(action);
    }
  }

  /**
   * Spawn the Overseer from its compiled entrypoint, with the session-start
   * environment passed through unmodified (R4.1, R8.1, R8.2). stdout is piped so the
   * readiness marker can be scanned and forwarded verbatim; stderr is inherited. The
   * `exit` handler here is the only source of `overseer-exited`, which is what keeps
   * a restart strictly sequential.
   */
  function startOverseer(): void {
    childStdoutTail = "";
    const spawned = spawn(process.execPath, [OVERSEER_ENTRYPOINT], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child = spawned;

    spawned.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      childStdoutTail += text;
      if (childStdoutTail.includes(OVERSEER_READY_MARKER)) {
        childStdoutTail = "";
        dispatch({ kind: "overseer-ready" });
      } else {
        // Retain only enough tail to catch a marker split across two chunks.
        const keep = OVERSEER_READY_MARKER.length;
        if (childStdoutTail.length > keep) {
          childStdoutTail = childStdoutTail.slice(-keep);
        }
      }
    });

    spawned.on("exit", (code) => {
      if (child === spawned) {
        child = null;
      }
      dispatch({ kind: "overseer-exited", status: code });
    });
  }

  /** Ask the child to stop. Its `exit` handler raises the deciding event. */
  function stopOverseer(): void {
    child?.kill("SIGTERM");
  }

  /** Close every file watcher the builder's host opened. */
  function stopWatcher(): void {
    for (const watcher of openWatchers) {
      watcher.close();
    }
    openWatchers.clear();
  }

  // -- Builder wiring -------------------------------------------------------
  //
  // Diagnostics go through TypeScript's own formatter, so each names its source file
  // with the line and character position and nothing is formatted here (R6.1). The
  // formatter wants a host for the current directory, canonical file names and the
  // newline; `ts.sys` has all three.
  const formatHost: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCanonicalFileName: (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    getNewLine: () => ts.sys.newLine,
  };

  /** Print one compile diagnostic, and count it if it is an error. */
  function reportDiagnostic(diagnostic: ts.Diagnostic): void {
    if (diagnostic.category === ts.DiagnosticCategory.Error) {
      errorsThisCycle += 1;
    }
    process.stdout.write(
      ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost),
    );
  }

  /** Print the builder's own status lines, so build progress stays visible. */
  function reportBuilderStatus(diagnostic: ts.Diagnostic): void {
    process.stdout.write(
      ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost),
    );
  }

  /**
   * Turn a watch-status line into a compile-cycle event. This is the shell's
   * authority on where a cycle begins and ends: 6032 opens one and resets the
   * per-cycle bookkeeping, 6193 and 6194 settle it and raise `compile-complete`.
   * Nothing is read out of message text.
   */
  function reportWatchStatus(
    diagnostic: ts.Diagnostic,
    _newLine: string,
    _options: ts.CompilerOptions,
    errorCount?: number,
  ): void {
    process.stdout.write(
      ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost),
    );

    switch (diagnostic.code) {
      case TS_COMPILE_START:
        emittedThisCycle = false;
        errorsThisCycle = 0;
        dispatch({ kind: "compile-start" });
        return;
      case TS_COMPILE_COMPLETE_ONE:
      case TS_COMPILE_COMPLETE_MANY: {
        const emitted = emittedThisCycle;
        emittedThisCycle = false;
        // The largest of the reporter's count and the shell's own tally. 6193 means
        // "found 1 error", so floor it at 1.
        const reported = errorCount ?? 0;
        const floor = diagnostic.code === TS_COMPILE_COMPLETE_ONE ? 1 : 0;
        const errors = Math.max(reported, errorsThisCycle, floor);
        errorsThisCycle = 0;
        dispatch({
          kind: "compile-complete",
          errorCount: errors,
          emitted,
        });
        return;
      }
      default:
        return;
    }
  }

  try {
    const host = ts.createSolutionBuilderWithWatchHost(
      ts.sys,
      undefined,
      reportDiagnostic,
      reportBuilderStatus,
      reportWatchStatus,
    );

    // Wrap writeFile so the settled-cycle handler knows whether the cycle emitted.
    // This records the shell's own writes as they happen; it does not observe the
    // compiled output and involves no timer (R4.5, R5.5).
    const innerWriteFile = host.writeFile?.bind(host);
    host.writeFile = (
      path: string,
      data: string,
      writeByteOrderMark?: boolean,
    ): void => {
      emittedThisCycle = true;
      innerWriteFile?.(path, data, writeByteOrderMark);
    };

    // Wrap the host's two watch entry points to collect every watcher the builder
    // opens, so a signal can close them all. Watch behaviour is unchanged.
    const innerWatchFile = host.watchFile.bind(host);
    host.watchFile = (
      path,
      callback,
      pollingInterval,
      options,
    ): ts.FileWatcher => {
      const watcher = innerWatchFile(path, callback, pollingInterval, options);
      openWatchers.add(watcher);
      return trackedWatcher(watcher, openWatchers);
    };
    const innerWatchDirectory = host.watchDirectory.bind(host);
    host.watchDirectory = (
      path,
      callback,
      recursive,
      options,
    ): ts.FileWatcher => {
      const watcher = innerWatchDirectory(path, callback, recursive, options);
      openWatchers.add(watcher);
      return trackedWatcher(watcher, openWatchers);
    };

    const builder = ts.createSolutionBuilderWithWatch(
      host,
      [...projectList],
      { incremental: true },
      {},
    );
    builder.build();
  } catch (error) {
    // The watcher never started. Rethrow unframed for the caller to frame; no
    // Overseer child exists to clean up.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason);
  }

  // -- Signal handling ------------------------------------------------------
  //
  // SIGINT / SIGTERM raise a `signal` event; the core turns it into a stop of the
  // child then of the watchers, and stops driving. The process exits 0 once the
  // child has gone and the watchers are closed (R1.6).
  function onSignal(signal: "SIGINT" | "SIGTERM"): void {
    const hadChild = state.overseer !== "none";
    dispatch({ kind: "signal", signal });
    // With no child alive nothing will fire `exit`, so exit here instead.
    if (!hadChild) {
      process.exit(0);
    } else {
      const waitForExit = (): void => {
        if (child === null) {
          process.exit(0);
        } else {
          setImmediate(waitForExit);
        }
      };
      waitForExit();
    }
  }

  process.on("SIGINT", () => {
    onSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    onSignal("SIGTERM");
  });
}

// ---------------------------------------------------------------------------
// The CLI entry. This layer exists so the dev-supervisor bin can be one import and
// one call, like its siblings generate-registry and build-image-tree. All CLI policy
// lives here: environment defaulting, error framing, exit statuses.

/**
 * This function starts a dev session for the current `MICROSERVICES` value: it
 * derives the project list, then hands it to the shell. Called from
 * src/bin/dev-supervisor.ts; it owns both steps' failure reporting and exit statuses
 * (R1.4, R1.5, R2.4).
 *
 * The list is derived before, and separately from, starting the shell, so a bad
 * `MICROSERVICES` value exits 1 with no watcher and no Overseer ever existing. Its
 * message reaches stderr verbatim, because {@link projectListFrom}'s messages carry
 * their own prefixes and the dev path fails with exactly the text an image build
 * fails with (R2.4). A watcher that fails to start is framed here instead. Both
 * exit 1, and on success this function does not return.
 */
export function runDevSupervisorCli(): void {
  // Deriving the list resolves the selector and lists the microservice directory
  // once. It defaults to `process.env.MICROSERVICES`, so the bin reads nothing.
  let projectList: readonly string[];
  try {
    projectList = devProjectList();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${reason}\n`);
    process.exit(1);
  }

  try {
    runDevSupervisor(projectList, process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[dev] failed to start the build watcher: ${reason}\n`,
    );
    process.exit(1);
  }
}

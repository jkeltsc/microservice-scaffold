// The Dev_Server supervisor (design "4. packages/build-tools/src/dev-supervisor.ts").
//
// The supervisor is factored into a pure decision core and a process-effect
// shell, mirroring the Overseer's own boot() / index.ts split. This module
// currently declares only the decision core's types and the initial state; the
// decision function, the event fold, the Project_List derivation, and the shell
// are added by later tasks in this same file.
//
// The factoring is not stylistic: Requirement 5 (the two-watcher race) is
// verified by a model-based property test over generated event interleavings,
// and that is only possible without spawning processes if the decision is a
// pure function over these types.

/** Everything the supervisor learns about the world, as a typed event. */
export type DevEvent =
  /** TS 6032: a watched source changed. */
  | { readonly kind: "file-change" }
  /** The builder began a Compile_Pass. */
  | { readonly kind: "compile-start" }
  /**
   * TS 6193 / TS 6194: the Compile_Pass settled.
   * `errorCount` comes from WatchStatusReporter's typed parameter.
   * `emitted` is true when the pass wrote at least one file into the
   * Compiled_Tree, recorded by the host's writeFile hook (see 4c).
   */
  | {
      readonly kind: "compile-complete";
      readonly errorCount: number;
      readonly emitted: boolean;
    }
  /** The child wrote its existing "[boot] Overseer listening on port N" line. */
  | { readonly kind: "overseer-ready" }
  /** The child process exited, for any reason. */
  | { readonly kind: "overseer-exited"; readonly status: number | null }
  /** SIGINT / SIGTERM reached the supervisor. */
  | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" };

/** The lifecycle of the single Overseer child the supervisor may own. */
export type OverseerPhase = "none" | "starting" | "running" | "stopping";

export interface DevState {
  /** The child's lifecycle phase. At most one child exists in any phase. */
  readonly overseer: OverseerPhase;
  /** True between compile-start and its compile-complete. */
  readonly compiling: boolean;
  /**
   * Monotonic counter advanced by a zero-error Compile_Pass that either emitted
   * output or is the first clean pass of the session (the warm-tree case, where
   * a complete Compiled_Tree is already on disk — R4.8). It identifies a
   * Last_Good_Output generation without inspecting the filesystem.
   */
  readonly generation: number;
  /** The generation the live (or starting) child was launched from; null when none. */
  readonly runningGeneration: number | null;
  /** A restart owed once the current child finishes exiting. */
  readonly restartPending: boolean;
  /**
   * Set when the child died on its own or failed to bind. Blocks any new child
   * until the next clean Compile_Pass (R4.7, R6.5).
   */
  readonly awaitingCleanPass: boolean;
  /** True once any clean Compile_Pass has completed in this session. */
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
 * The session's starting state: no child, not compiling, no Last_Good_Output
 * yet. `generation` starts at 0 and a zero-error Compile_Pass advances it when
 * it either emitted or is the session's first clean pass (the warm-tree case),
 * so the first started child carries generation 1.
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

/** A log action to stdout. */
function logOut(message: string): DevAction {
  return { kind: "log", stream: "stdout", message };
}

/** A log action to stderr. */
function logErr(message: string): DevAction {
  return { kind: "log", stream: "stderr", message };
}

/**
 * The restart decision (design "4b. The pure decision core"). A total, pure
 * function: no I/O, no timers, no clock, no filesystem, and no observation of
 * the Compiled_Tree. Every Requirement 5 and Requirement 6 gating obligation is
 * a statement about this function's output, which is what makes them testable
 * over generated event interleavings without spawning a process.
 *
 * Two invariants fall out of the phase machine rather than being checked
 * separately: `start-overseer` is emitted only from phase `none`, so two
 * children can never be alive at once (R5.7); and `start-overseer` always
 * carries the current `generation`, which a zero-error pass advances — either
 * because it emitted, or because it is the session's first clean pass over an
 * already complete tree — so the executed output is always a Last_Good_Output
 * (R6.6, R4.8).
 */
export function decide(
  state: DevState,
  event: DevEvent,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  // Once a signal has set `terminating`, the shell stops driving: no event
  // produces any further action or state change.
  if (state.terminating) {
    return { state, actions: [] };
  }

  switch (event.kind) {
    // A watched source changed, or the builder began a Compile_Pass. Mark the
    // session compiling and emit no start/stop action, so a running child keeps
    // serving the Last_Good_Output (R5.2, R5.3). A burst of edits during a pass
    // coalesces here without a debounce timer: these events emit nothing, and
    // only the burst's final `compile-complete` can produce a restart (R5.4).
    case "file-change":
    case "compile-start":
      return { state: { ...state, compiling: true }, actions: [] };

    case "compile-complete":
      return decideCompileComplete(state, event);

    // The child bound its HTTP server: starting → running, and record the
    // restart (R4.6).
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

    // SIGINT / SIGTERM: set `terminating`, stop the child (if any) then the
    // watcher (R1.6).
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

/** The `compile-complete` transitions (design "4b" rules table). */
function decideCompileComplete(
  state: DevState,
  event: Extract<DevEvent, { kind: "compile-complete" }>,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  const settled = { ...state, compiling: false };

  // An erroring pass: log the completion and error count, emit no start/stop,
  // leave `generation` unadvanced so the live child keeps serving the last good
  // output (R5.8, R6.2, R6.3, R6.6). When no Last_Good_Output exists yet, also
  // log that no Overseer will start (R6.7).
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

  // A clean pass that emitted nothing. Its handling splits three ways
  // (design 4b), because whether a pass emitted governs restart decisions
  // only, never whether the session starts a server at all (R4.8, R5.1).
  if (!event.emitted) {
    // Gate in force: the output on disk is the same output that just crashed
    // or failed to bind, so relaunching it would only produce a crash loop.
    // The gate stays; no start, `generation` unadvanced (R4.7, R6.5).
    if (state.awaitingCleanPass) {
      return { state: settled, actions: [completionLog0] };
    }

    // No gate, and no Last_Good_Output yet: the warm-tree initial start. A
    // zero-error pass that emitted nothing means every output was already up
    // to date, so the Compiled_Tree is complete and consistent. Advance
    // `generation` (to 1) — the session's first clean pass counts even without
    // an emit — set `hasLastGood`, and start the Overseer at that generation.
    // Phase is `none` here, because no clean pass has yet started a child
    // (R4.8, R5.1, R6.4).
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

    // No gate, and a Last_Good_Output already exists: a no-op pass. Log the
    // completion, emit no start/stop, leave `generation` unadvanced — a
    // settled session converges to the same running child (R4.5, R5.4, R5.6).
    return { state: settled, actions: [completionLog0] };
  }

  // A clean, emitting pass: a new Last_Good_Output. Advance `generation`, set
  // `hasLastGood`, clear `awaitingCleanPass` (R4.7, R6.5 gate lifts on the next
  // clean pass). Then restart according to the child's phase.
  const generation = state.generation + 1;
  const advanced: DevState = {
    ...settled,
    generation,
    hasLastGood: true,
    awaitingCleanPass: false,
  };

  switch (state.overseer) {
    // No child: start one against this generation (R4.2, R5.1, R6.4).
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

    // A live child: stop it and owe a restart. The `overseer-exited` handler
    // starts the replacement once it has exited, so the restart is strictly
    // sequential and two children never overlap (R5.7).
    case "running":
      return {
        state: { ...advanced, overseer: "stopping", restartPending: true },
        actions: [completionLog0, { kind: "stop-overseer" }],
      };

    // A child mid-start or mid-stop: record that a restart is owed. The pending
    // flag is consumed when the current child settles (R5.4, R5.7).
    case "starting":
    case "stopping":
      return {
        state: { ...advanced, restartPending: true },
        actions: [completionLog0],
      };
  }
}

/** The `overseer-exited` transitions (design "4b" rules table). */
function decideOverseerExited(
  state: DevState,
  event: Extract<DevEvent, { kind: "overseer-exited" }>,
): { readonly state: DevState; readonly actions: readonly DevAction[] } {
  const status = event.status;

  switch (state.overseer) {
    // A requested stop completed. Honour a pending restart by starting the
    // replacement at the current `generation` (R5.7); otherwise settle to none.
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

    // The child died before binding: log to stderr, block any new child until
    // the next clean pass, start no replacement (R4.7).
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

    // A spontaneous exit: same handling as a failed bind — log to stderr, block
    // until the next clean pass, start no replacement (R6.5).
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

    // No child was expected to exit; nothing to do.
    case "none":
      return { state, actions: [] };
  }
}

/**
 * Fold an event sequence through `decide`, returning the final state and the
 * concatenated action trace (design "4b"). This is the single folding
 * implementation shared by the model-based property test and the shell, so
 * both derive their state and actions from exactly the same reduction.
 *
 * When `state` is omitted the fold starts from `initialDevState`. Pure and
 * total, inheriting those properties from `decide`.
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
// 4a. Project_List derivation (design "4a. Project_List derivation").
//
// The solution builder is handed root projects rather than a single project,
// and that root list IS the Project_List (R3.6): the required shared packages
// (topological), then the selected microservices, then the Overseer. It reuses
// existing build-tools code — `resolveSelected` for the Selector and
// `requiredSharedPackages` for the closure — rather than reimplementing
// selection or closure logic (R2.1), so the dev path selects microservices by
// exactly the semantics a Container build uses (R2.2) and a cold tree builds in
// an order that works (R3.7). An unmatched identifier surfaces as the existing
// `[selector:unmatched]` error (R2.4).
//
// This is the same root order `image-tree.ts` hands to `tsc --build`, computed
// by the same two functions, so dev and Container builds agree by construction.
// `packages/build-tools` and `packages/integration-tests` are excluded from the
// list by construction: neither is a selected microservice, the Overseer, or a
// discovered shared package (build-tools is bin-only with no `main`/`types`
// barrel; integration-tests is not `@microservices`-scoped), so neither can
// enter the closure.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMicroserviceDirectories } from "./generate-registry.js";
import { resolveSelected } from "./selector.js";
import {
  discoverSharedPackages,
  requiredSharedPackages,
  type ReadDependencies,
  type SharedPackage,
} from "./shared-packages.js";

/** The Overseer's package directory; the last root project in build order. */
const OVERSEER_PACKAGE_DIR = "packages/overseer";

/** Workspace scope; used to filter a manifest's `@microservices` dependencies. */
const WORKSPACE_SCOPE = "@microservices";

/**
 * The Project_List: the root projects handed to the solution builder, in build
 * order — the required shared packages (topological), then the selected
 * microservices (`packages/microservices/<identifier>`), then the Overseer
 * (`packages/overseer`) (R3.6). Each returned entry is a repo-relative package
 * directory, exactly the form `image-tree.ts` passes to `tsc --build` and the
 * form the TypeScript solution builder expects as a root name.
 *
 * Pure over its injected inputs so it is property-testable against in-memory
 * layouts; {@link devProjectList} supplies the real-filesystem defaults. It
 * composes `resolveSelected` and `requiredSharedPackages` and reimplements
 * neither selection nor closure logic, so an unmatched identifier surfaces as
 * the existing `[selector:unmatched]` error and an unresolved shared dependency
 * as the existing `[shared:unresolved]` error (R2.4).
 *
 * @param selector the raw `MICROSERVICES` value, passed through unmodified.
 * @param directories the candidate microservice directory names.
 * @param shared the discovered shared packages keyed by `@microservices/<name>`.
 * @param readDependencies reads the `@microservices`-scoped `dependencies` keys
 *   of a workspace given its package dir (the microservice and Overseer roots).
 * @throws `[selector:unmatched]` / `[selector:empty]` from `resolveSelected`;
 *   `[shared:unresolved]` from `requiredSharedPackages`.
 */
export function projectListFrom(
  selector: string | undefined,
  directories: readonly string[],
  shared: ReadonlyMap<string, SharedPackage>,
  readDependencies: ReadDependencies,
): readonly string[] {
  const selected = resolveSelected(selector, directories);
  const required = requiredSharedPackages(selected, shared, readDependencies);

  return [
    ...required.map((pkg) => pkg.packageDir),
    ...selected.map((identifier) => `packages/microservices/${identifier}`),
    OVERSEER_PACKAGE_DIR,
  ];
}

/**
 * Read the `@microservices`-scoped `dependencies` keys of a workspace manifest
 * at `packageDir` (e.g. "packages/overseer"). This is the {@link ReadDependencies}
 * reader `requiredSharedPackages` uses for its microservice and Overseer roots;
 * shared-package edges come from discovery instead. An absent or unparsable
 * manifest, or one with no `dependencies`, yields an empty list. Mirrors the
 * `readSharedDeps` reader `image-tree.ts` uses, so both build paths read
 * dependencies identically.
 */
function readSharedDependencies(packageDir: string): readonly string[] {
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
  } catch {
    return [];
  }
  return Object.keys(manifest.dependencies ?? {}).filter((dep) =>
    dep.startsWith(`${WORKSPACE_SCOPE}/`),
  );
}

/**
 * The real-filesystem Project_List for the current `MICROSERVICES` value. Lists
 * `packages/microservices/` exactly once, here at startup — nothing in the
 * steady state re-lists it (R7.1, R7.3) — and discovers shared packages once,
 * then delegates to the pure {@link projectListFrom}. Reads the `MICROSERVICES`
 * environment value the same way `generateRegistry` does, so the dev path's
 * microservice set matches the registry it was generated against by
 * construction.
 */
export function devProjectList(
  selector = process.env.MICROSERVICES,
): readonly string[] {
  return projectListFrom(
    selector,
    listMicroserviceDirectories(),
    discoverSharedPackages(),
    readSharedDependencies,
  );
}

// ---------------------------------------------------------------------------
// 4c. The process-effect shell (design "4c. The process-effect shell").
//
// The shell owns everything impure and holds NO branching policy of its own. It
// translates the TypeScript solution builder's callbacks and the Overseer
// child's lifecycle into DevEvents, feeds each event to `decide`, and performs
// the returned DevActions in order. Every restart decision therefore lives in
// the pure core above; the shell only wires callbacks to events and events to
// effects.
//
// The two-watcher race (Requirement 5) is absent by construction: the shell
// never watches `dist/` and runs no debounce timer. The authority on "a compile
// cycle finished with N errors" is a callback in this same event loop
// (`reportWatchStatus`), and "did this cycle emit" is bookkeeping about the
// builder's own writeFile calls (the `writeFile` wrapper) — never an
// observation of the filesystem (R5.6).

import { spawn, type ChildProcess } from "node:child_process";

import ts from "typescript";

/** The Overseer process entrypoint the child is spawned from (R4.1, R9.1). */
const OVERSEER_ENTRYPOINT = "packages/overseer/dist/index.js";

/**
 * The existing Overseer boot line the shell scans the child's stdout for; its
 * appearance is the only non-invasive bind signal available, since R9.4 forbids
 * a dev-specific branch in `packages/overseer/src/`. Matched as a substring of a
 * forwarded stdout chunk and raised as `overseer-ready`.
 */
const OVERSEER_READY_MARKER = "[boot] Overseer listening on port";

/**
 * TypeScript watch-status diagnostic codes, verified against typescript@5.9.3
 * (design "One process owns both sides"):
 *   6032 — "File change detected. Starting incremental compilation..." (cycle start)
 *   6193 — "Found 1 error. Watching for file changes."                 (cycle settled)
 *   6194 — "Found {0} errors. Watching for file changes."              (cycle settled)
 */
const TS_COMPILE_START = 6032;
const TS_COMPILE_COMPLETE_ONE = 6193;
const TS_COMPILE_COMPLETE_MANY = 6194;

/**
 * Wrap a `FileWatcher` so that closing it (whether by the builder or by
 * `stop-watcher`) also drops it from the tracking set, keeping the set free of
 * already-closed watchers.
 */
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
 * Start the Dev_Server process-effect shell: drive the TypeScript solution
 * builder over `projectList` in watch mode and own the Overseer child, feeding
 * every observed transition through {@link decide} and performing the returned
 * {@link DevAction}s in order. This is the shell task 5.2's bin wrapper calls;
 * it is the obvious, documented entry point for starting a Dev_Session.
 *
 * The function does not return under normal operation — it installs the watcher
 * and the signal handlers and lets the event loop drive the session until a
 * `SIGINT`/`SIGTERM` closes the watchers and the child exits, at which point the
 * process exits with status 0. A failure to launch the Build_Watcher throws so
 * the bin can report `[dev] failed to start the build watcher: <reason>` and
 * exit non-zero (design "Common_Startup step failure"); no Overseer child is
 * spawned in that case because the spawn is downstream of the watcher build.
 *
 * @param projectList the root projects handed to the solution builder, in build
 *   order (see {@link projectListFrom} / {@link devProjectList}).
 * @param env the environment resolved at Dev_Session start, passed to every
 *   Overseer child with no mutation (R8.1, R8.2).
 */
export function runDevSupervisor(
  projectList: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  // The single source of truth for the session, folded forward by `decide`. The
  // shell never inspects or mutates it except through `dispatch`.
  let state = initialDevState;

  // The one Overseer child the supervisor may own, and the buffer that
  // accumulates a partial stdout line so the readiness marker is matched even
  // when it is split across chunks.
  let child: ChildProcess | null = null;
  let childStdoutTail = "";

  // Emit-detection bookkeeping (design 4c "Emit detection"): the wrapped
  // writeFile flips this true; the settled-cycle handler reads and resets it to
  // supply `compile-complete`'s `emitted`. This records the supervisor's OWN
  // writes — it is not a watcher on `dist/`.
  let emittedThisCycle = false;

  // Error-count bookkeeping for the current cycle. The `errorCount` parameter
  // that `createSolutionBuilderWithWatch` passes to the watch-status reporter is
  // NOT reliably populated for the settle diagnostics (TS 6193 / TS 6194): under
  // the solution builder it arrives as 0 even when a project failed, so trusting
  // it alone would classify an erroring pass as clean and start the Overseer
  // against a tree that did not compile (violating R5.1, R6.2, R6.7). So the
  // shell counts the error-category diagnostics TypeScript reports through
  // `reportDiagnostic` during the cycle and uses the larger of that tally and
  // the reporter's typed count. Reset at each `compile-start`.
  let errorsThisCycle = 0;

  // The file watchers the builder's host opened. `createSolutionBuilderWithWatch`
  // returns a `SolutionBuilder` with no `close()`, so the watchers are owned by
  // the host's `WatchHost.watchFile`/`watchDirectory`. The shell wraps those two
  // to collect every `FileWatcher` the builder opens, then closes them all in
  // `stopWatcher` — that IS closing the builder's watchers (design 4c "Signals").
  const openWatchers = new Set<ts.FileWatcher>();

  /**
   * Perform a single DevAction. The shell holds no policy here: it just carries
   * out the effect the pure core named.
   */
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

  /**
   * Feed one event through the pure core, commit the next state, and perform
   * every returned action in order. The single point where the shell advances
   * the decision core.
   */
  function dispatch(event: DevEvent): void {
    const result = decide(state, event);
    state = result.state;
    for (const action of result.actions) {
      perform(action);
    }
  }

  /**
   * Spawn the Overseer from its compiled entrypoint with the session-start
   * environment passed through unmodified (R4.1, R8.1, R8.2). stdout is piped so
   * the readiness marker can be scanned and forwarded verbatim; stderr is
   * inherited so the child's own diagnostics reach the terminal directly. The
   * child's `exit` handler is the ONLY source of `overseer-exited`, which keeps
   * a restart strictly sequential (design 4c "stop-overseer").
   */
  function startOverseer(): void {
    childStdoutTail = "";
    const spawned = spawn(process.execPath, [OVERSEER_ENTRYPOINT], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child = spawned;

    spawned.stdout?.on("data", (chunk: Buffer) => {
      // Forward verbatim, then scan for the readiness marker across chunk
      // boundaries using a small retained tail.
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

  /**
   * Request a stop of the running child. Sends `SIGTERM` and returns; the
   * child's own `exit` handler raises `overseer-exited`, so the decision core
   * (not this function) decides what happens next.
   */
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

  // -- Builder wiring (design 4c "Builder wiring") --------------------------
  //
  // Diagnostics are reported through TypeScript's own
  // `formatDiagnosticsWithColorAndContext`, so each names the source file with
  // its line and character position (R6.1) with no formatting done here. The
  // formatter needs a host describing the current directory, canonical file
  // names and the newline; `ts.sys` supplies all three.
  const formatHost: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCanonicalFileName: (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    getNewLine: () => ts.sys.newLine,
  };

  /** Report a single compile diagnostic, file/line/character named by TS. */
  function reportDiagnostic(diagnostic: ts.Diagnostic): void {
    // Tally errors so the settle handler has a reliable count even when the
    // solution builder passes `errorCount === 0` on the summary diagnostic.
    if (diagnostic.category === ts.DiagnosticCategory.Error) {
      errorsThisCycle += 1;
    }
    process.stdout.write(
      ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost),
    );
  }

  /**
   * The solution builder's own status lines (e.g. "Projects in this build").
   * Forwarded verbatim through the same formatter so build progress is visible.
   */
  function reportBuilderStatus(diagnostic: ts.Diagnostic): void {
    process.stdout.write(
      ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost),
    );
  }

  /**
   * The watch-status reporter — the authority on cycle boundaries. Its typed
   * `errorCount` parameter is the error count fed straight into
   * `compile-complete`; nothing is recovered from message text. TS 6032 opens a
   * cycle; TS 6193 / TS 6194 settle it. The settled event carries `emitted`,
   * read and reset from the writeFile bookkeeping flag.
   */
  function reportWatchStatus(
    diagnostic: ts.Diagnostic,
    _newLine: string,
    _options: ts.CompilerOptions,
    errorCount?: number,
  ): void {
    // Surface the status line itself so cycle boundaries are visible.
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
        // The reporter's typed `errorCount` is unreliable under the solution
        // builder (0 even on failure), so take the larger of it and the errors
        // this shell tallied from `reportDiagnostic`. TS 6193 ("Found 1 error")
        // itself implies at least one error, so floor the count at 1 for it.
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

    // Wrap the host's writeFile so the settled-cycle handler can supply
    // `emitted`. This is bookkeeping about the supervisor's own writes into the
    // Compiled_Tree, recorded as the writes happen — not a `dist/` watcher, and
    // not a debounce timer (R4.5, R5.5).
    const innerWriteFile = host.writeFile?.bind(host);
    host.writeFile = (
      path: string,
      data: string,
      writeByteOrderMark?: boolean,
    ): void => {
      emittedThisCycle = true;
      innerWriteFile?.(path, data, writeByteOrderMark);
    };

    // Wrap the host's watch entry points to collect every FileWatcher the
    // builder opens, so `stop-watcher` can close them all on a signal. The
    // wrappers only register the returned watcher; they change no watch
    // behavior.
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
    // A failure to launch the Build_Watcher: rethrow so the bin reports
    // `[dev] failed to start the build watcher: <reason>` and exits non-zero. No
    // Overseer child was spawned — the spawn is downstream of a clean compile.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason);
  }

  // -- Signal handling (design 4c "Signals") --------------------------------
  //
  // SIGINT / SIGTERM raise a `signal` event; the decision core turns that into
  // `stop-overseer` (if a child exists) then `stop-watcher`, and stops driving.
  // After the child has exited and the watchers are closed, the process exits 0.
  function onSignal(signal: "SIGINT" | "SIGTERM"): void {
    const hadChild = state.overseer !== "none";
    dispatch({ kind: "signal", signal });
    // If no child was alive, nothing will fire `exit`, so exit now that the
    // watchers are closed. Otherwise the child's `exit` handler above runs the
    // (now no-op) decision and the process is free to exit once it settles.
    if (!hadChild) {
      process.exit(0);
    } else {
      // Exit once the child has gone; poll cheaply on the next tick since the
      // exit handler clears `child`.
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
// 4d. The CLI entry (design "4d. The bin and its CLI entry function").
//
// The layer between the `dev-supervisor` bin and the shell above. It exists so
// the bin can be a one-liner — a single import and a single call — exactly like
// its two siblings (`generate-registry`, `build-image-tree`), whose functions
// likewise own their environment defaulting and their exit behavior. All CLI
// policy lives here; the bin layer holds none.

/**
 * The `dev-supervisor` bin's entry point: derive the Project_List for the
 * current `MICROSERVICES` Selector and start the Dev_Server shell, owning the
 * process-level failure reporting and exit statuses for both (R1.4, R1.5, R2.4).
 *
 * Ordering is a guarantee, not an accident: the Project_List is derived
 * **before**, and separately from, starting the shell, so a bad Selector exits 1
 * without a Build_Watcher or an Overseer ever existing.
 *
 * The two failure paths report differently, and both are observable contracts
 * preserved exactly:
 *
 * - A **Selector failure** reaches stderr **verbatim**, with no prefix added
 *   here. {@link devProjectList} / {@link projectListFrom} already produce
 *   prefixed messages — `[selector:unmatched]`, `[selector:empty]`,
 *   `[shared:unresolved]` — and re-wrapping one as a watcher-launch failure
 *   would corrupt the contract R2.4 states. The dev path therefore fails on a
 *   bad Selector with exactly the message an image build fails with.
 * - A **Build_Watcher launch failure** is framed as
 *   `[dev] failed to start the build watcher: <reason>` (design "Common_Startup
 *   step failure"). {@link runDevSupervisor} throws unframed for this case, so
 *   this function is the single author of the `[dev]` framing. No Overseer child
 *   exists to clean up: the spawn is downstream of a clean compile, so a watcher
 *   that never launched leaves nothing behind.
 *
 * Both exit non-zero with status 1. On success the function does not return —
 * {@link runDevSupervisor} lets the event loop drive the session until a signal
 * ends it.
 */
export function runDevSupervisorCli(): void {
  // Deriving the Project_List lists `packages/microservices/` once and resolves
  // the Selector. `devProjectList()` defaults its selector to
  // `process.env.MICROSERVICES`, so no environment reading happens in the bin.
  let projectList: readonly string[];
  try {
    projectList = devProjectList();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${reason}\n`);
    process.exit(1);
  }

  // Start the Build_Watcher and own the Overseer child.
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

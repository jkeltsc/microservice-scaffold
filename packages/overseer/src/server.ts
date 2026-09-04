// @scaffold/overseer — HTTP listener startup.
//
// Implements design "Overseer Startup Sequence" step 6 / step 7 and Components
// and Interfaces (`src/server.ts`): the Overseer binds its single HTTP server
// on the configured port (Requirement 3.1). This is the final step of the boot
// pipeline — nothing binds the socket until every earlier validation step has
// passed.
//
// `startServer` wraps Express's callback/event-based `listen` in a promise so
// the boot pipeline can `await` a successfully bound server. The promise
// resolves with the underlying `http.Server` once the "listening" event fires,
// and rejects if binding fails (for example, `EADDRINUSE` when the port is
// already taken) so the caller can abort startup with a non-zero exit code.

import type { Express } from "express";
import type { Server } from "node:http";

/**
 * Start the Overseer's HTTP server on the given port.
 *
 * Begins listening via {@link Express.listen} and resolves once the server has
 * successfully bound the port (the "listening" event). If binding fails before
 * that — most commonly `EADDRINUSE` when the port is in use — the returned
 * promise rejects with the emitted error instead.
 *
 * The one-shot listeners registered for the initial "listening" and "error"
 * events are removed once the promise settles, so they do not interfere with
 * later error handling on the long-lived server.
 *
 * @param app - The fully composed Express application to serve.
 * @param port - The TCP port to bind to.
 * @returns A promise that resolves with the bound `http.Server`, or rejects
 *   with the binding error.
 */
export function startServer(app: Express, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port);

    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve(server);
    };

    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
}

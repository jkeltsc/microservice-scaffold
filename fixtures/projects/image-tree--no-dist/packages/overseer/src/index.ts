// Minimal local Overseer_Library stand-in: just enough surface for this
// scenario's Entry_Module to compile. Declares no platform dependency (R3.6).
import type { MicroserviceRegistry } from "@fx-imgnodist/contracts";

export interface BootOptions {
  readonly microserviceRegistry: MicroserviceRegistry;
  readonly env: Record<string, string | undefined>;
}
export interface BootResult {
  readonly ok: boolean;
  readonly messages: readonly string[];
}
export function boot(_options: BootOptions): BootResult {
  return { ok: true, messages: [] };
}
export async function startServer(_app: unknown, _port: number): Promise<void> {
  return Promise.resolve();
}

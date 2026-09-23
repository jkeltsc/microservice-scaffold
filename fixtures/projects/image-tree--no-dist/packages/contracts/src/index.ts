// Minimal local stand-in for the request-handler contract this scenario's
// Entry_Module and registry compile against. This is a fixture's own stub,
// declaring no dependency on the platform (R3.6).
export interface MicroserviceRegistryEntry {
  readonly identifier: string;
  readonly module: unknown;
  readonly sourcePackage: string;
}
export type MicroserviceRegistry = readonly MicroserviceRegistryEntry[];

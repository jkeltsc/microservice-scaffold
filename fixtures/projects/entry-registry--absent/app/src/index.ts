// Consumer-owned Entry_Module. Not read by the Build_System. Present so the
// Entry_Package is a real package; the fault is the ABSENT generated registry
// at src/generated/microservice-registry.ts, which this module would import.
export {};

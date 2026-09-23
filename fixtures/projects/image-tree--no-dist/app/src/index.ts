import { boot, startServer } from "@fx-imgnodist/overseer";

import { microserviceRegistry } from "./generated/microservice-registry.js";

async function main(): Promise<void> {
  const result = boot({ microserviceRegistry, env: process.env });
  if (!result.ok) {
    process.exit(1);
    return;
  }
  await startServer(undefined, 3000);
}

void main();

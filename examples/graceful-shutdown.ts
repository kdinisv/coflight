/**
 * Graceful shutdown: drain in-flight requests before exiting.
 * Forced shutdown: abort everything if the process must stop NOW.
 */

import { createCoflight } from "@kdinisv/coflight";

const api = createCoflight<string, unknown>();

async function handleRequest(id: string): Promise<unknown> {
  return api.run(
    `request:${id}`,
    ({ signal }) =>
      fetch(`https://api.example.com/data/${id}`, { signal }).then((r) =>
        r.json(),
      ),
    { timeout: 5_000, ttl: 2_000 },
  );
}

// ── Graceful drain ──────────────────────────────────────────────
// drain() stops accepting new calls and waits for every active
// flight (including background SWR refreshes) to settle.

process.on("SIGTERM", async () => {
  console.log("SIGTERM received — draining active requests…");
  await api.drain();
  console.log("All requests completed. Exiting.");
  process.exit(0);
});

// ── Forced shutdown ─────────────────────────────────────────────
// shutdown() aborts every in-flight operation, clears cache and
// stale stores, and resolves any pending drain().

process.on("SIGINT", () => {
  console.log("SIGINT received — aborting everything.");
  api.shutdown();
  process.exit(1);
});

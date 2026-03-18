/**
 * Stale-while-revalidate for service discovery:
 * callers always get a fast response from the stale store,
 * while a background refresh keeps the endpoint up to date.
 */

import { createCoflight, composeKey } from "@kdinisv/coflight";

interface ServiceEndpoint {
  host: string;
  port: number;
  healthy: boolean;
}

const discovery = createCoflight<string, ServiceEndpoint>({
  staleTtl: 60_000, // keep stale endpoints for up to 60 s
  maxStaleEntries: 50, // bound memory
});

async function resolveService(name: string): Promise<ServiceEndpoint> {
  return discovery.run(
    composeKey("service", name),
    async ({ signal }) => {
      const res = await fetch(`http://consul:8500/v1/catalog/service/${name}`, {
        signal,
      });
      const [entry] = await res.json();
      return {
        host: entry.ServiceAddress,
        port: entry.ServicePort,
        healthy: true,
      };
    },
    {
      ttl: 5_000, // cache for 5 s
      swr: true, // after TTL, return stale and refresh in the background
    },
  );
}

// First call fetches from Consul. Within 5 s, the cached address is used.
// After 5 s, if a stale address exists, it is returned immediately while
// a single background fetch refreshes it. No request waits on the network
// unless the service has never been resolved before.

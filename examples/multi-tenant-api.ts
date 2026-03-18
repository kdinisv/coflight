/**
 * Multi-tenant API: each tenant's config is fetched once,
 * even if dozens of concurrent requests arrive at the same time.
 * Scoped key factories guarantee tenant isolation by construction.
 */

import { createCoflight, createScopedKeyFactory } from "@kdinisv/coflight";

interface TenantConfig {
  maxUsers: number;
  features: string[];
}

// The factory enforces exactly one scope value (tenantId).
// Forgetting it or mixing up argument order is a compile-time + runtime error.
const configKey = createScopedKeyFactory("config", "tenantId");

const configs = createCoflight<string, TenantConfig>();

async function getTenantConfig(
  tenantId: string,
  signal?: AbortSignal,
): Promise<TenantConfig> {
  return configs.run(
    configKey(tenantId), // "config:acme-corp"
    ({ signal }) =>
      fetch(`https://internal-api/tenants/${tenantId}/config`, { signal }).then(
        (r) => r.json(),
      ),
    { signal, ttl: 30_000, staleIfError: true },
  );
}

// In an Express-style handler, many concurrent requests for the same
// tenant share a single fetch — no thundering herd on the config DB.
//
// app.get("/api/:tenantId/config", async (req, res) => {
//   const config = await getTenantConfig(req.params.tenantId, req.signal);
//   res.json(config);
// });

/**
 * Auth-scoped fetch: the deduplication key includes both
 * tenantId and userId so that data for different users
 * and tenants is never accidentally shared.
 */

import { createCoflight, createKeyFactory } from "@kdinisv/coflight";

interface UserProfile {
  id: string;
  name: string;
  email: string;
}

// The factory gives every key a "profile" prefix.
// .scoped(tenantId, userId) adds two more dimensions.
const profileKey = createKeyFactory("profile");

const profiles = createCoflight<string, UserProfile>();

async function getUserProfile(
  tenantId: string,
  userId: string,
  authToken: string,
  signal?: AbortSignal,
): Promise<UserProfile> {
  // Key: "profile:tenant-a:user-42" — different tenants never collide.
  return profiles.run(
    profileKey.scoped(tenantId, userId),
    ({ signal }) =>
      fetch(`https://api.example.com/users/${userId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal,
      }).then((r) => r.json()),
    { signal, ttl: 10_000 },
  );
}

// Multiple WebSocket handlers or API routes calling getUserProfile
// for the same tenant + user will share a single fetch.

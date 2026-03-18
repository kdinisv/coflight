import { describe, it, expect } from "vitest";
import {
  escapeKeySegment,
  composeKey,
  createKeyFactory,
  createScopedKeyFactory,
  createKeyNamespace,
} from "../src/keys.js";

// ---------------------------------------------------------------------------
// escapeKeySegment
// ---------------------------------------------------------------------------

describe("escapeKeySegment", () => {
  it("returns plain strings unchanged", () => {
    expect(escapeKeySegment("hello")).toBe("hello");
  });

  it("escapes colons", () => {
    expect(escapeKeySegment("a:b")).toBe("a\\:b");
  });

  it("escapes backslashes", () => {
    expect(escapeKeySegment("a\\b")).toBe("a\\\\b");
  });

  it("escapes both colons and backslashes", () => {
    expect(escapeKeySegment("a\\:b")).toBe("a\\\\\\:b");
  });

  it("handles empty strings", () => {
    expect(escapeKeySegment("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// composeKey
// ---------------------------------------------------------------------------

describe("composeKey", () => {
  it("joins segments with colons", () => {
    expect(composeKey("user", "42")).toBe("user:42");
  });

  it("escapes colons in segments", () => {
    expect(composeKey("ns", "key:with:colons")).toBe("ns:key\\:with\\:colons");
  });

  it("works with a single segment", () => {
    expect(composeKey("solo")).toBe("solo");
  });

  it("handles many segments", () => {
    expect(composeKey("a", "b", "c", "d")).toBe("a:b:c:d");
  });

  it("throws on zero segments", () => {
    expect(() => composeKey()).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// createKeyFactory
// ---------------------------------------------------------------------------

describe("createKeyFactory", () => {
  it("returns prefix alone when called with no segments", () => {
    const f = createKeyFactory("user");
    expect(f()).toBe("user");
  });

  it("prepends prefix to segments", () => {
    const f = createKeyFactory("user");
    expect(f("42")).toBe("user:42");
    expect(f("a", "b")).toBe("user:a:b");
  });

  it("escapes prefix and segments", () => {
    const f = createKeyFactory("ns:x");
    expect(f("val:y")).toBe("ns\\:x:val\\:y");
  });

  it("scoped() prepends prefix and scope", () => {
    const f = createKeyFactory("profile");
    expect(f.scoped("tenant-a", "42")).toBe("profile:tenant-a:42");
  });

  it("scoped() with no extra segments", () => {
    const f = createKeyFactory("profile");
    expect(f.scoped("tenant-a")).toBe("profile:tenant-a");
  });
});

// ---------------------------------------------------------------------------
// createScopedKeyFactory
// ---------------------------------------------------------------------------

describe("createScopedKeyFactory", () => {
  it("creates a factory with fixed arity", () => {
    const f = createScopedKeyFactory("config", "tenantId", "env");
    expect(f("acme", "prod")).toBe("config:acme:prod");
  });

  it("throws on wrong number of values", () => {
    const f = createScopedKeyFactory("config", "tenantId", "env");
    expect(() => (f as any)("only-one")).toThrow(RangeError);
    expect(() => (f as any)("a", "b", "c")).toThrow(RangeError);
  });

  it("zero-scope factory returns just the prefix", () => {
    const f = createScopedKeyFactory("singleton");
    expect(f()).toBe("singleton");
  });

  it("escapes values", () => {
    const f = createScopedKeyFactory("k", "id");
    expect(f("a:b")).toBe("k:a\\:b");
  });
});

// ---------------------------------------------------------------------------
// createKeyNamespace
// ---------------------------------------------------------------------------

describe("createKeyNamespace", () => {
  it("creates typed factories from schema", () => {
    const keys = createKeyNamespace({
      user: ["tenantId", "userId"],
      session: ["sessionId"],
    });

    expect(keys.user("acme", "42")).toBe("user:acme:42");
    expect(keys.session("sess-1")).toBe("session:sess-1");
  });

  it("enforces arity per schema entry", () => {
    const keys = createKeyNamespace({
      user: ["tenantId", "userId"],
    });

    expect(() => (keys.user as any)("only-one")).toThrow(RangeError);
  });

  it("handles empty scopes", () => {
    const keys = createKeyNamespace({
      global: [],
    });

    expect(keys.global()).toBe("global");
  });
});

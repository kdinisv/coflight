const KEY_SEPARATOR = ":";

/**
 * Escape a single key segment so colons and backslashes
 * do not collide with the separator used by `composeKey`.
 */
export function escapeKeySegment(segment: string): string {
  return segment.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function joinEscaped(parts: string[]): string {
  return parts.map(escapeKeySegment).join(KEY_SEPARATOR);
}

/**
 * Compose a deduplication key from one or more segments.
 * Each segment is escaped before joining with `:`.
 *
 * @example
 * composeKey("user", "tenant-a", "42")  // "user:tenant-a:42"
 * composeKey("user", "a:b")             // "user:a\\:b"
 */
export function composeKey(...segments: string[]): string {
  if (segments.length === 0) {
    throw new RangeError("composeKey requires at least one segment");
  }
  return joinEscaped(segments);
}

/** A key factory bound to a fixed prefix. */
export interface KeyFactory {
  /** Build a key: `prefix:seg1:seg2:…` */
  (...segments: string[]): string;
  /** Build a scoped key: `prefix:scope:seg1:seg2:…` */
  scoped(scope: string, ...segments: string[]): string;
}

/**
 * Create a reusable factory that prepends a fixed `prefix` to every key.
 *
 * @example
 * const userKey = createKeyFactory("user");
 * userKey("42")                // "user:42"
 * userKey.scoped("acme", "42") // "user:acme:42"
 */
export function createKeyFactory(prefix: string): KeyFactory {
  const escapedPrefix = escapeKeySegment(prefix);

  const factory = ((...segments: string[]): string => {
    if (segments.length === 0) return escapedPrefix;
    return escapedPrefix + KEY_SEPARATOR + joinEscaped(segments);
  }) as KeyFactory;

  factory.scoped = (scope: string, ...segments: string[]): string => {
    let key = escapedPrefix + KEY_SEPARATOR + escapeKeySegment(scope);
    if (segments.length > 0) {
      key += KEY_SEPARATOR + joinEscaped(segments);
    }
    return key;
  };

  return factory;
}

/**
 * Create a factory whose arity is fixed by the number of `scopes`.
 * At runtime, the number of values must match the number of scopes.
 *
 * @example
 * const configKey = createScopedKeyFactory("config", "tenantId", "env");
 * configKey("acme", "prod")  // "config:acme:prod"
 * configKey("acme")          // throws RangeError
 */
export function createScopedKeyFactory(
  prefix: string,
  ...scopes: string[]
): (...values: string[]) => string {
  const escapedPrefix = escapeKeySegment(prefix);
  const expectedLength = scopes.length;

  return (...values: string[]): string => {
    if (values.length !== expectedLength) {
      throw new RangeError(
        `Key "${prefix}" expects ${expectedLength} scope(s) (${scopes.join(", ")}), got ${values.length}`,
      );
    }
    if (expectedLength === 0) return escapedPrefix;
    return escapedPrefix + KEY_SEPARATOR + joinEscaped(values);
  };
}

/** Inferred namespace type: each schema entry becomes a factory function. */
export type KeyNamespace<S extends Record<string, readonly string[]>> = {
  [N in keyof S]: (...values: string[]) => string;
};

/**
 * Create a typed namespace of key factories from a schema object.
 * Each property name becomes the key prefix; the array documents
 * (and enforces at runtime) the required scope values.
 *
 * @example
 * const keys = createKeyNamespace({
 *   user:    ["tenantId", "userId"],
 *   session: ["sessionId"],
 * });
 * keys.user("acme", "42")    // "user:acme:42"
 * keys.session("sess-abc")   // "session:sess-abc"
 */
export function createKeyNamespace<
  const S extends Record<string, readonly string[]>,
>(schema: S): KeyNamespace<S> {
  const result = {} as Record<string, (...values: string[]) => string>;
  for (const name of Object.keys(schema)) {
    result[name] = createScopedKeyFactory(name, ...(schema[name] as string[]));
  }
  return result as KeyNamespace<S>;
}

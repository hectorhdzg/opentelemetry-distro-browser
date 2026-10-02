// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createLocalStorageKeyValueStorage,
  type KeyValueStorage,
} from "../storage/keyValueStorage.js";
import { isNonEmptyString } from "../shared/isNonEmptyString.js";
import type { MicrosoftOpenTelemetryBrowserUserContext } from "../types.js";
import { USER_STORAGE_KEY } from "./constants.js";

interface StoredUser {
  anonymousId: string;
  authenticatedUserId?: string;
  accountId?: string;
}

/** Generates a 128-bit hexadecimal identifier from the platform's cryptographic random source. */
function generateAnonymousId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isStoredUser(value: unknown): value is StoredUser {
  if (typeof value !== "object" || value === null || !("anonymousId" in value)) return false;
  const user = value as Partial<StoredUser>;
  const hasAuthenticatedUser = user.authenticatedUserId !== undefined;
  return (
    isNonEmptyString(user.anonymousId) &&
    (!hasAuthenticatedUser || isNonEmptyString(user.authenticatedUserId)) &&
    (user.accountId === undefined || (hasAuthenticatedUser && isNonEmptyString(user.accountId)))
  );
}

export interface UserContextProvider {
  getAnonymousUserId(): string;
  getAuthenticatedUserId(): string | undefined;
  getAccountId(): string | undefined;
}

export function createUserContext(
  initialEnabled: boolean,
  storage: KeyValueStorage = createLocalStorageKeyValueStorage(
    "User storage unavailable; using in-memory identity.",
  ),
): {
  context: MicrosoftOpenTelemetryBrowserUserContext;
  provider: UserContextProvider;
} {
  let enabled = initialEnabled;
  let anonymousId = generateAnonymousId();
  let authenticatedUserId: string | undefined;
  let accountId: string | undefined;

  function currentUser(): StoredUser {
    return {
      anonymousId,
      ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
      ...(accountId === undefined ? {} : { accountId }),
    };
  }

  function save(): boolean {
    if (!enabled) return true;
    return storage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser()));
  }

  /**
   * Saves the current identity. A failed write removes the stale record, which also lets the
   * storage adapter recover from quota exhaustion, then retries once. Returns `false` only after
   * the stale record was removed, so a later page load cannot restore superseded identity.
   */
  function persist(): boolean {
    if (save()) return true;
    requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
    return save();
  }

  function requireIdentityCleared(cleared: boolean): void {
    if (!cleared) {
      throw new Error("Unable to clear persisted user identity.");
    }
  }

  function requireIdentityPersisted(persisted: boolean): void {
    if (!persisted) {
      throw new Error("Unable to persist user identity.");
    }
  }

  // Best effort: identity may have been persisted by an earlier page load, but this instance has
  // not enabled persistence, so storage that stays inaccessible must not break the caller.
  function clearPersistedAuthenticatedContext(): void {
    const result = storage.getItem(USER_STORAGE_KEY);
    if (!result.success) {
      storage.removeItem(USER_STORAGE_KEY);
      return;
    }
    if (result.value === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (
      !isStoredUser(parsed) ||
      !storage.setItem(USER_STORAGE_KEY, JSON.stringify({ anonymousId: parsed.anonymousId }))
    ) {
      storage.removeItem(USER_STORAGE_KEY);
    }
  }

  if (enabled) {
    const result = storage.getItem(USER_STORAGE_KEY);
    if (!result.success) {
      enabled = false;
    } else {
      if (result.value === null) {
        if (!save()) enabled = false;
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.value);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (isStoredUser(parsed)) {
          anonymousId = parsed.anonymousId;
          authenticatedUserId = parsed.authenticatedUserId;
          accountId = parsed.accountId;
        } else {
          diag.warn("Invalid stored user identity; creating a new identity.");
          if (!save()) {
            // The storage adapter already reports failures; initialization continues in memory.
            storage.removeItem(USER_STORAGE_KEY);
            enabled = false;
          }
        }
      }
    }
  }

  const context: MicrosoftOpenTelemetryBrowserUserContext = {
    setAuthenticatedUserContext(userId, newAccountId) {
      if (!isNonEmptyString(userId)) {
        throw new TypeError("Authenticated user ID must be a non-empty string.");
      }
      if (newAccountId !== undefined && !isNonEmptyString(newAccountId)) {
        throw new TypeError("Account ID must be a non-empty string when provided.");
      }
      authenticatedUserId = userId;
      accountId = newAccountId;
      requireIdentityPersisted(persist());
    },
    clearAuthenticatedUserContext() {
      authenticatedUserId = undefined;
      accountId = undefined;
      if (!enabled) {
        clearPersistedAuthenticatedContext();
      } else if (!persist()) {
        // Stale authentication is already removed; keep the anonymous identity in memory.
        enabled = false;
        diag.warn("User identity persistence disabled; storage writes failed.");
      }
    },
    setEnabled(newEnabled) {
      if (newEnabled) {
        enabled = true;
        try {
          requireIdentityPersisted(persist());
        } catch (error) {
          enabled = false;
          throw error;
        }
      } else {
        const removed = storage.removeItem(USER_STORAGE_KEY);
        // Only an instance that persisted identity must guarantee removal; otherwise clear any
        // identity left by an earlier page load on a best-effort basis.
        if (enabled) requireIdentityCleared(removed);
        enabled = false;
      }
    },
  };

  return {
    context,
    provider: {
      getAnonymousUserId: () => anonymousId,
      getAuthenticatedUserId: () => authenticatedUserId,
      getAccountId: () => accountId,
    },
  };
}

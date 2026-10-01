// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { createDefaultSessionIdGenerator } from "@opentelemetry/browser-sdk/session";
import {
  createLocalStorageKeyValueStorage,
  type KeyValueStorage,
} from "../storage/keyValueStorage.js";
import type { MicrosoftOpenTelemetryBrowserUserContext } from "../types.js";

const storageKey = "opentelemetry-user";

interface StoredUser {
  anonymousId: string;
  authenticatedUserId?: string;
  accountId?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStoredUser(value: unknown): value is StoredUser {
  if (typeof value !== "object" || value === null || !("anonymousId" in value)) return false;
  const user = value as Partial<StoredUser>;
  return (
    isNonEmptyString(user.anonymousId) &&
    (user.authenticatedUserId === undefined || isNonEmptyString(user.authenticatedUserId)) &&
    (user.accountId === undefined || isNonEmptyString(user.accountId))
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
  const generatedAnonymousId = createDefaultSessionIdGenerator().generateSessionId();
  let anonymousId = generatedAnonymousId;
  let authenticatedUserId: string | undefined;
  let accountId: string | undefined;

  function currentUser(): StoredUser {
    return {
      anonymousId,
      ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
      ...(accountId === undefined ? {} : { accountId }),
    };
  }

  function save(): void {
    if (!enabled) return;
    storage.setItem(storageKey, JSON.stringify(currentUser()));
  }

  function clearPersistedAuthenticatedContext(): void {
    const stored = storage.getItem(storageKey);
    if (stored === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (isStoredUser(parsed)) {
      storage.setItem(storageKey, JSON.stringify({ anonymousId: parsed.anonymousId }));
    } else {
      storage.removeItem(storageKey);
    }
  }

  if (enabled) {
    const stored = storage.getItem(storageKey);
    if (stored === null) {
      save();
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (isStoredUser(parsed)) {
        anonymousId = parsed.anonymousId;
        authenticatedUserId = parsed.authenticatedUserId;
        accountId = parsed.accountId;
      } else {
        diag.warn("Invalid stored user identity; creating a new identity.");
        save();
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
      save();
    },
    clearAuthenticatedUserContext() {
      authenticatedUserId = undefined;
      accountId = undefined;
      if (enabled) {
        save();
      } else {
        clearPersistedAuthenticatedContext();
      }
    },
    setEnabled(newEnabled) {
      enabled = newEnabled;
      if (newEnabled) {
        save();
      } else {
        storage.removeItem(storageKey);
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

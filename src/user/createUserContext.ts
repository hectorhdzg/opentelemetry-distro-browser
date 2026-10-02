// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { createDefaultSessionIdGenerator } from "@opentelemetry/browser-sdk/session";
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

  function save(): boolean {
    if (!enabled) return true;
    return storage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser()));
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

  function clearPersistedAuthenticatedContext(): void {
    const result = storage.getItem(USER_STORAGE_KEY);
    if (!result.success) {
      requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
      return;
    }
    if (result.value === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (isStoredUser(parsed)) {
      requireIdentityCleared(
        storage.setItem(USER_STORAGE_KEY, JSON.stringify({ anonymousId: parsed.anonymousId })),
      );
    } else {
      requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
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
            requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
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
      requireIdentityPersisted(save());
    },
    clearAuthenticatedUserContext() {
      authenticatedUserId = undefined;
      accountId = undefined;
      if (enabled) {
        if (!save()) {
          requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
          if (!save()) enabled = false;
        }
      } else {
        clearPersistedAuthenticatedContext();
      }
    },
    setEnabled(newEnabled) {
      if (newEnabled) {
        enabled = true;
        try {
          if (!save()) {
            requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
            requireIdentityPersisted(save());
          }
        } catch (error) {
          enabled = false;
          throw error;
        }
      } else {
        if (!enabled) return;
        requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
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

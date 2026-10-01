// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";

/**
 * Minimal persistence contract shared by browser context managers.
 *
 * A future cookie manager can implement this contract without changing user or session lifecycle
 * code. Values remain owned and serialized by each manager.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createLocalStorageKeyValueStorage(unavailableMessage: string): KeyValueStorage {
  let unavailable = false;

  function useStorage<T>(operation: (storage: Storage) => T, fallback: T): T {
    if (unavailable) return fallback;
    try {
      if (typeof localStorage !== "undefined") return operation(localStorage);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.name !== "SecurityError" && error.name !== "QuotaExceededError")
      ) {
        throw error;
      }
    }
    unavailable = true;
    diag.warn(unavailableMessage);
    return fallback;
  }

  return {
    getItem: (key) => useStorage((storage) => storage.getItem(key), null),
    setItem: (key, value) => useStorage((storage) => storage.setItem(key, value), undefined),
    removeItem: (key) => useStorage((storage) => storage.removeItem(key), undefined),
  };
}

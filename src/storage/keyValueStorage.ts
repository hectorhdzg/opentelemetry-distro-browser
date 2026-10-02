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
  setItem(key: string, value: string): boolean;
  removeItem(key: string): boolean;
}

export function createLocalStorageKeyValueStorage(unavailableMessage: string): KeyValueStorage {
  let unavailable = false;
  let writesUnavailable = false;
  let warned = false;

  function warnOnce(): void {
    if (warned) return;
    warned = true;
    diag.warn(unavailableMessage);
  }

  function useStorage<T>(
    operation: (storage: Storage) => T,
    fallback: T,
    operationType: "read" | "write" | "remove",
  ): T {
    if (unavailable || (operationType === "write" && writesUnavailable)) return fallback;
    try {
      if (typeof localStorage !== "undefined") {
        const result = operation(localStorage);
        if (operationType === "remove") writesUnavailable = false;
        return result;
      }
      unavailable = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.name !== "SecurityError" && error.name !== "QuotaExceededError")
      ) {
        throw error;
      }
      if (operationType === "write" && error.name === "QuotaExceededError") {
        writesUnavailable = true;
      } else {
        unavailable = true;
      }
    }
    warnOnce();
    return fallback;
  }

  return {
    getItem: (key) => useStorage((storage) => storage.getItem(key), null, "read"),
    setItem: (key, value) =>
      useStorage(
        (storage) => {
          storage.setItem(key, value);
          return true;
        },
        false,
        "write",
      ),
    removeItem: (key) =>
      useStorage(
        (storage) => {
          storage.removeItem(key);
          return true;
        },
        false,
        "remove",
      ),
  };
}

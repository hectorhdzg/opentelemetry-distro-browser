// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  propagation,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { withoutPageOperation } from "../instrumentation/pageView/pageViewCorrelation.js";

/** Page correlation contributed by one tracing instance. */
export interface PageCorrelation {
  decorate(active: Context): Context;
}

interface ContextOwner {
  readonly correlation?: PageCorrelation;
}

// Tracing instances in initialization order; the first with page views supplies correlation.
const owners: ContextOwner[] = [];
let storage: ContextManager | undefined;

/**
 * The page-lifetime context manager. The OpenTelemetry API allows only one registration, so
 * context storage is shared for the page, while the page operation comes from the earliest
 * running tracing instance and passes on when that instance shuts down. Contexts bound before a
 * handoff therefore stay valid.
 */
const pageContextManager: ContextManager = {
  active() {
    const correlation = owners.find((owner) => owner.correlation)?.correlation;
    const active = storage?.active() ?? ROOT_CONTEXT;
    return correlation ? correlation.decorate(active) : withoutPageOperation(active);
  },
  with: (ctx, fn, thisArg, ...args) =>
    storage ? storage.with(ctx, fn, thisArg, ...args) : fn.apply(thisArg, args),
  bind: (ctx, target) => (storage ? storage.bind(ctx, target) : target),
  enable() {
    return this;
  },
  // Called when the global context API is disabled, which unregisters this manager.
  disable() {
    storage?.disable();
    storage = undefined;
    return this;
  },
};

/**
 * Adds a tracing instance as a page correlation owner. The first instance on the page also
 * registers its context manager and propagator, which then serve the page for its lifetime.
 * Never replaces registrations by another SDK; the API reports conflicts.
 *
 * @returns Removes the owner, passing page correlation to the next tracing instance.
 */
export function addContextOwner(
  owner: ContextOwner,
  createContextManager: () => ContextManager,
  createPropagator: () => TextMapPropagator,
): () => void {
  if (!storage) {
    const manager = createContextManager().enable();
    storage = manager;
    if (context.setGlobalContextManager(pageContextManager)) {
      propagation.setGlobalPropagator(createPropagator());
    } else {
      storage = undefined;
      manager.disable();
    }
  }
  owners.push(owner);
  return () => {
    const index = owners.indexOf(owner);
    if (index >= 0) owners.splice(index, 1);
  };
}

/** Whether a distribution instance has registered the page context and propagation. */
export function isPageContextRegistered(): boolean {
  return storage !== undefined;
}

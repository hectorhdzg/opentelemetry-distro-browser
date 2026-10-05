// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  createContextKey,
  diag,
  ProxyTracerProvider,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { createNoopLogger, logs, type LoggerProvider } from "@opentelemetry/api-logs";

/**
 * The isolated pipelines owned by one distribution instance. A signal the instance does not
 * collect is left undefined, so it is never served by another instance's pipeline.
 */
export interface InstancePipelines {
  readonly tracerProvider?: TracerProvider;
  readonly loggerProvider?: LoggerProvider;
}

// Running instances in initialization order; the first is the default route.
const running: InstancePipelines[] = [];
const SELECTED_INSTANCE = createContextKey("@microsoft/opentelemetry-browser instance");

/** Hands out no-op tracers: a proxy without a delegate never records. */
export const noopTracerProvider: TracerProvider = /* @__PURE__ */ new ProxyTracerProvider();
/** Hands out no-op loggers. */
export const noopLoggerProvider: LoggerProvider = { getLogger: () => createNoopLogger() };

function selectInstance(): InstancePipelines | undefined {
  const selected = context.active().getValue(SELECTED_INSTANCE) as InstancePipelines | undefined;
  const instance = selected ?? running[0];
  if (instance && running.includes(instance)) return instance;
  diag.warn("No running @microsoft/opentelemetry-browser instance; its telemetry is dropped");
}

/**
 * The global tracer provider. Resolves the owning instance once, when a tracer is acquired, and
 * returns that instance's own tracer, so later spans never depend on mutable routing state.
 * An instance that does not collect traces gets a no-op tracer, never another instance's.
 */
const tracerRouter: TracerProvider = {
  getTracer: (name, version, options) =>
    (selectInstance()?.tracerProvider ?? noopTracerProvider).getTracer(name, version, options),
};

/** The global logger provider, with the same binding rules as {@link tracerRouter}. */
const loggerRouter: LoggerProvider = {
  getLogger: (name, version, options) =>
    (selectInstance()?.loggerProvider ?? noopLoggerProvider).getLogger(name, version, options),
};

/**
 * Adds an instance to the routing table and registers the global router for each signal it
 * collects. Never replaces a provider registered by another SDK.
 *
 * @returns Removes the instance from routing. Tracers and loggers already bound to it stay bound
 * to its own pipelines rather than moving to another instance.
 */
export function addInstance(instance: InstancePipelines): () => void {
  if (
    instance.tracerProvider &&
    (trace.getTracerProvider() as ProxyTracerProvider).getDelegate?.() !== tracerRouter
  ) {
    // The API reports a conflicting registration itself.
    trace.setGlobalTracerProvider(tracerRouter);
  }
  if (
    instance.loggerProvider &&
    logs.getLoggerProvider() !== loggerRouter &&
    logs.setGlobalLoggerProvider(loggerRouter) !== loggerRouter
  ) {
    diag.warn("Another OpenTelemetry LoggerProvider is registered; it serves the global Logs API");
  }
  running.push(instance);
  return () => {
    const index = running.indexOf(instance);
    if (index >= 0) running.splice(index, 1);
  };
}

/**
 * Whether a running instance collects traces. That instance registered the page-wide context
 * manager and propagator, which the OpenTelemetry API does not allow a second SDK to replace.
 */
export function isTracingRunning(): boolean {
  return running.some((instance) => instance.tracerProvider);
}

/**
 * Routes tracers and loggers acquired inside `callback` to `instance` instead of the default.
 *
 * @internal Application-facing instance selection is follow-up work.
 */
export function withInstance<T>(instance: InstancePipelines, callback: () => T): T {
  return context.with(context.active().setValue(SELECTED_INSTANCE, instance), callback);
}

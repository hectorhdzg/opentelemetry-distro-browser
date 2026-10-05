// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  propagation,
  type Attributes,
  type ContextManager,
  type TextMapPropagator,
  type TracerProvider as TracerProviderApi,
} from "@opentelemetry/api";
import type { LoggerProvider as LoggerProviderApi } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { TracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import {
  addInstance,
  isTracingRunning,
  noopLoggerProvider,
  noopTracerProvider,
} from "./instanceRouter.js";

/** Resolved pipeline configuration for one distribution instance. */
export interface TelemetryInstanceOptions {
  readonly resourceAttributes: Attributes;
  /** An empty list leaves traces off for this instance. */
  readonly spanProcessors: readonly SpanProcessor[];
  /** An empty list leaves logs off for this instance. */
  readonly logRecordProcessors: readonly LogRecordProcessor[];
  readonly contextManager?: ContextManager;
  readonly propagators?: readonly TextMapPropagator[];
}

/** One instance's isolated providers, which its instrumentations bind to directly. */
export interface TelemetryInstance {
  readonly tracerProvider: TracerProviderApi;
  readonly loggerProvider: LoggerProviderApi;
  /** Stops routing to the instance, then shuts down both of its providers. */
  shutdown(): Promise<void>;
}

let diagLoggerSet = false;

/**
 * Creates an instance's own tracer and logger providers and adds it to the global router.
 *
 * @remarks
 * Nothing is shared with other instances except the page-wide context manager and propagator,
 * which the OpenTelemetry API allows only one SDK to register. The first running instance that
 * collects traces registers them; while it runs, a later instance's context options are unused.
 */
export function startTelemetryInstance(options: TelemetryInstanceOptions): TelemetryInstance {
  // Matches the upstream browser SDK, which installs a console diagnostic logger once per page.
  if (!diagLoggerSet) {
    diagLoggerSet = true;
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }
  const resource = defaultResource().merge(resourceFromAttributes(options.resourceAttributes));
  const tracerProvider = options.spanProcessors.length
    ? new TracerProvider({ resource, spanProcessors: options.spanProcessors.slice() })
    : undefined;
  const loggerProvider = options.logRecordProcessors.length
    ? new LoggerProvider({ resource, processors: options.logRecordProcessors.slice() })
    : undefined;

  if (tracerProvider && !isTracingRunning()) {
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: options.propagators?.slice() ?? [
          new W3CTraceContextPropagator(),
          new W3CBaggagePropagator(),
        ],
      }),
    );
    context.setGlobalContextManager((options.contextManager ?? new StackContextManager()).enable());
  }

  const remove = addInstance({ tracerProvider, loggerProvider });
  return {
    tracerProvider: tracerProvider ?? noopTracerProvider,
    loggerProvider: loggerProvider ?? noopLoggerProvider,
    async shutdown() {
      remove();
      const results = await Promise.allSettled([
        tracerProvider?.shutdown(),
        loggerProvider?.shutdown(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Telemetry provider shutdown failed");
    },
  };
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
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
import { addInstance, noopLoggerProvider, noopTracerProvider } from "./instanceRouter.js";
import { addContextOwner, type PageCorrelation } from "./pageContext.js";

/** Resolved pipeline configuration for one distribution instance. */
export interface TelemetryInstanceOptions {
  readonly resourceAttributes: Attributes;
  /** An empty list leaves traces off for this instance. */
  readonly spanProcessors: readonly SpanProcessor[];
  /** An empty list leaves logs off for this instance. */
  readonly logRecordProcessors: readonly LogRecordProcessor[];
  readonly contextManager?: ContextManager;
  /** Page correlation applied to the page context while this instance owns it. */
  readonly correlation?: PageCorrelation;
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
 * which the OpenTelemetry API allows only one SDK to register: the first tracing instance on the
 * page registers them for the page's lifetime. Page correlation comes from the earliest running
 * tracing instance and passes on when it shuts down. If startup fails, the providers it created
 * are shut down before the failure is rethrown.
 */
export async function startTelemetryInstance(
  options: TelemetryInstanceOptions,
): Promise<TelemetryInstance> {
  // Matches the upstream browser SDK, which installs a console diagnostic logger once per page.
  // Documented on useMicrosoftOpenTelemetry; applications can replace it after initialization.
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
  const shutdownProviders = async (): Promise<void> => {
    const results = await Promise.allSettled([
      tracerProvider?.shutdown(),
      loggerProvider?.shutdown(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Telemetry provider shutdown failed");
  };

  let removeContextOwner: (() => void) | undefined;
  try {
    removeContextOwner =
      tracerProvider &&
      addContextOwner(
        { correlation: options.correlation },
        () => options.contextManager ?? new StackContextManager(),
        () =>
          new CompositePropagator({
            propagators: options.propagators?.slice() ?? [
              new W3CTraceContextPropagator(),
              new W3CBaggagePropagator(),
            ],
          }),
      );
  } catch (error) {
    try {
      await shutdownProviders();
    } catch (cleanupFailure) {
      diag.error("Telemetry initialization cleanup failed", cleanupFailure);
    }
    throw error;
  }

  const removeInstance = addInstance({ tracerProvider, loggerProvider });
  return {
    tracerProvider: tracerProvider ?? noopTracerProvider,
    loggerProvider: loggerProvider ?? noopLoggerProvider,
    async shutdown() {
      removeInstance();
      removeContextOwner?.();
      await shutdownProviders();
    },
  };
}

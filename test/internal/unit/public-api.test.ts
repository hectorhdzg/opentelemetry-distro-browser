// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContextManager, TextMapPropagator } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { expectTypeOf, it } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserTraceOptions,
  type PageViewInstrumentationConfig,
} from "../../../src/index.js";

it("exposes distro-owned configuration and lifecycle contracts", () => {
  expectTypeOf(useMicrosoftOpenTelemetry)
    .parameter(0)
    .toEqualTypeOf<MicrosoftOpenTelemetryBrowserOptions | undefined>();
  expectTypeOf(useMicrosoftOpenTelemetry).returns.toEqualTypeOf<
    Promise<MicrosoftOpenTelemetryBrowser>
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserOptions>().toEqualTypeOf<
    | "spanProcessors"
    | "logRecordProcessors"
    | "instrumentations"
    | "pageView"
    | "session"
    | "traces"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["traces"]>().toEqualTypeOf<
    MicrosoftOpenTelemetryBrowserTraceOptions | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions["contextManager"]>().toEqualTypeOf<
    ContextManager | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions["propagators"]>().toEqualTypeOf<
    readonly TextMapPropagator[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["session"]>().toEqualTypeOf<
    { enabled?: boolean } | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["spanProcessors"]>().toEqualTypeOf<
    SpanProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["logRecordProcessors"]>().toEqualTypeOf<
    LogRecordProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["instrumentations"]>().toEqualTypeOf<
    readonly BrowserInstrumentation[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["pageView"]>().toEqualTypeOf<
    PageViewInstrumentationConfig | undefined
  >();
  expectTypeOf<Instrumentation>().toExtend<BrowserInstrumentation>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser>().not.toHaveProperty("forceFlush");
});

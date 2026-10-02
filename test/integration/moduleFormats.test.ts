// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { logs as LogsApi } from "@opentelemetry/api-logs";
import type {
  context as ContextApi,
  diag as DiagApi,
  propagation as PropagationApi,
  trace as TraceApi,
} from "@opentelemetry/api";
import { expect, it } from "vitest";
import type { useMicrosoftOpenTelemetry as Initialize } from "../../src/index.js";
import type { getInstrumentations as LoadInstrumentations } from "../../src/instrumentation/browserInstrumentation/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

interface BrowserBundle {
  readonly context: typeof ContextApi;
  readonly diag: typeof DiagApi;
  readonly logs: typeof LogsApi;
  readonly propagation: typeof PropagationApi;
  readonly trace: typeof TraceApi;
  readonly OPENTELEMETRY_BROWSER_VERSION: string;
  readonly useMicrosoftOpenTelemetry: typeof Initialize;
}

interface InstrumentationBundle {
  readonly getInstrumentations: typeof LoadInstrumentations;
}

interface AmdDefine {
  (dependencies: string[], factory: (exports: Record<string, unknown>) => void): void;
  amd?: object;
}

declare global {
  interface Window {
    Microsoft?: {
      OpenTelemetry?: BrowserBundle;
      OpenTelemetryInstrumentations?: InstrumentationBundle;
    };
    define?: AmdDefine;
  }
}

async function loadScript(file: string): Promise<HTMLScriptElement> {
  const script = document.createElement("script");
  const path = `../../dist/browser/${file}`;
  script.src = new URL(path, import.meta.url).href;
  const loaded = new Promise<void>((resolve, reject) => {
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${file}`)), {
      once: true,
    });
  });
  document.head.append(script);
  try {
    await loaded;
  } catch (error) {
    script.remove();
    throw error;
  }
  return script;
}

function getBrowserBundle(): BrowserBundle | undefined {
  return window.Microsoft?.OpenTelemetry;
}

function getInstrumentationBundle(): InstrumentationBundle | undefined {
  return window.Microsoft?.OpenTelemetryInstrumentations;
}

function createAmdBundle<T>(file: string): {
  bundle: Promise<T>;
  cancelTimeout: () => void;
  define: AmdDefine;
} {
  let resolveBundle!: (bundle: T) => void;
  let timeout = 0;
  const bundle = new Promise<T>((resolve, reject) => {
    timeout = window.setTimeout(() => reject(new Error(`${file} did not call AMD define`)), 1_000);
    resolveBundle = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
  });
  const define: AmdDefine = (dependencies, factory) => {
    expect(dependencies).toEqual(["exports"]);
    const exports = {};
    factory(exports);
    resolveBundle(exports as unknown as T);
  };
  define.amd = {};
  return {
    bundle,
    cancelTimeout: () => {
      void bundle.catch(() => undefined);
      clearTimeout(timeout);
    },
    define,
  };
}

async function exercise(bundle: BrowserBundle): Promise<void> {
  const pipeline = createInMemoryPipeline();
  const telemetry = await bundle.useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
  });
  try {
    bundle.trace.getTracer("module-format-test").startSpan("module-format").end();
    bundle.logs.getLogger("module-format-test").emit({ eventName: "module-format" });
    await telemetry.forceFlush();

    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "module-format",
    ]);
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "module-format",
    ]);
  } finally {
    try {
      await telemetry.shutdown();
    } finally {
      bundle.trace.disable();
      bundle.logs.disable();
      bundle.propagation.disable();
      bundle.context.disable();
      bundle.diag.disable();
    }
  }
}

it.each([
  "opentelemetry-browser.umd.js",
  "opentelemetry-browser.umd.min.js",
  "opentelemetry-browser.iife.js",
  "opentelemetry-browser.iife.min.js",
])("loads and initializes the %s global bundle", async (file) => {
  delete window.Microsoft;
  const script = await loadScript(file);
  try {
    const bundle = getBrowserBundle();
    expect(bundle?.OPENTELEMETRY_BROWSER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    if (!bundle) throw new Error(`${file} did not define Microsoft.OpenTelemetry`);
    await exercise(bundle);
  } finally {
    script.remove();
    delete window.Microsoft;
  }
});

it.each(["opentelemetry-browser.umd.js", "opentelemetry-browser.umd.min.js"])(
  "loads and initializes the %s bundle through AMD/RequireJS",
  async (file) => {
    const originalDefine = window.define;
    const { bundle, cancelTimeout, define } = createAmdBundle<BrowserBundle>(file);
    window.define = define;

    let script: HTMLScriptElement | undefined;
    try {
      script = await loadScript(file);
      await exercise(await bundle);
    } finally {
      cancelTimeout();
      script?.remove();
      window.define = originalDefine;
    }
  },
);

it.each([
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
  "opentelemetry-browser-instrumentations.iife.js",
  "opentelemetry-browser-instrumentations.iife.min.js",
])("loads the %s global instrumentation bundle", async (file) => {
  delete window.Microsoft;
  const script = await loadScript(file);
  try {
    const bundle = getInstrumentationBundle();
    expect(typeof bundle?.getInstrumentations).toBe("function");
    expect(
      await bundle?.getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
      }),
    ).toEqual([]);
  } finally {
    script.remove();
    delete window.Microsoft;
  }
});

it.each([
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
])("loads the %s instrumentation bundle through AMD/RequireJS", async (file) => {
  const originalDefine = window.define;
  const { bundle, cancelTimeout, define } = createAmdBundle<InstrumentationBundle>(file);
  window.define = define;

  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    expect(
      await (
        await bundle
      ).getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
      }),
    ).toEqual([]);
  } finally {
    cancelTimeout();
    script?.remove();
    window.define = originalDefine;
  }
});

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SpanContext } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import type { ExceptionData } from "../../../src/exporter/telemetryModels.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/shared/constants.js";

const instrumentationKey = "00000000-0000-0000-0000-000000000000";
const spanContext: SpanContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
};
const resource = { attributes: { "service.name": "browser-store" } };

function makeLog(overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord {
  return {
    hrTime: [1_735_689_600, 0],
    hrTimeObserved: [1_735_689_600, 0],
    spanContext,
    resource,
    instrumentationScope: { name: "test" },
    attributes: {},
    droppedAttributesCount: 0,
    ...overrides,
  } as unknown as ReadableLogRecord;
}

describe("Azure Monitor log envelope mapping", () => {
  it("maps exception semantic attributes and severity", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        severityNumber: 18,
        body: "request failed",
        attributes: {
          "exception.type": "TypeError",
          "exception.message": "Cannot read properties of undefined",
          "exception.stacktrace":
            "TypeError: Cannot read properties of undefined\n" +
            "    at checkout (https://shop.example.test/app.js:42:7)\n" +
            "restoreCart@https://shop.example.test/cart.js:18:3",
          "url.full": "https://shop.example.test/checkout",
          handled: false,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.name).toBe("Microsoft.ApplicationInsights.Exception");
    expect(envelope.tags["ai.internal.sdkVersion"]).toBe(`mot${OPENTELEMETRY_BROWSER_VERSION}`);
    expect(envelope.data).toEqual({
      baseType: "ExceptionData",
      baseData: {
        ver: 2,
        exceptions: [
          {
            typeName: "TypeError",
            message: "Cannot read properties of undefined",
            hasFullStack: true,
            stack:
              "TypeError: Cannot read properties of undefined\n" +
              "    at checkout (https://shop.example.test/app.js:42:7)\n" +
              "restoreCart@https://shop.example.test/cart.js:18:3",
            parsedStack: [
              {
                level: 0,
                method: "checkout",
                assembly: "at checkout (https://shop.example.test/app.js:42:7)",
                fileName: "https://shop.example.test/app.js",
                line: 42,
              },
              {
                level: 1,
                method: "restoreCart",
                assembly: "restoreCart@https://shop.example.test/cart.js:18:3",
                fileName: "https://shop.example.test/cart.js",
                line: 18,
              },
            ],
          },
        ],
        severityLevel: 3,
        properties: {
          "url.full": "https://shop.example.test/checkout",
          handled: "false",
        },
        measurements: undefined,
      },
    });
  });

  it("parses only stack frames and supports parentheses in filenames", () => {
    const stack =
      "user@example.com:404\n" +
      "    at render (https://example.test/app(foo).js:42:7)\n" +
      "    at hydrate bundle.js:21:5\n" +
      "restoreCart@app.js:18:3\n" +
      "loadCart@app.js:19\n" +
      "saveCart@https://example.test/cart.js:20\n" +
      "    at https://cdn.example.test/node_modules/@scope/pkg/index.js:22:4\n" +
      "https://cdn.example.test/node_modules/@scope/pkg/bare.js:23:5\n" +
      "bundle.js:23:5\n" +
      "src/relative.js:24:6\n" +
      "https://example.test/bootstrap.js:8:3\n" +
      "@https://example.test/anonymous.js:12:4";
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "Request failed:404",
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];

    expect(exception.parsedStack).toEqual([
      {
        level: 0,
        method: "render",
        assembly: "at render (https://example.test/app(foo).js:42:7)",
        fileName: "https://example.test/app(foo).js",
        line: 42,
      },
      {
        level: 1,
        method: "hydrate",
        assembly: "at hydrate bundle.js:21:5",
        fileName: "bundle.js",
        line: 21,
      },
      {
        level: 2,
        method: "restoreCart",
        assembly: "restoreCart@app.js:18:3",
        fileName: "app.js",
        line: 18,
      },
      {
        level: 3,
        method: "loadCart",
        assembly: "loadCart@app.js:19",
        fileName: "app.js",
        line: 19,
      },
      {
        level: 4,
        method: "saveCart",
        assembly: "saveCart@https://example.test/cart.js:20",
        fileName: "https://example.test/cart.js",
        line: 20,
      },
      {
        level: 5,
        method: "<no_method>",
        assembly: "at https://cdn.example.test/node_modules/@scope/pkg/index.js:22:4",
        fileName: "https://cdn.example.test/node_modules/@scope/pkg/index.js",
        line: 22,
      },
      {
        level: 6,
        method: "<no_method>",
        assembly: "https://cdn.example.test/node_modules/@scope/pkg/bare.js:23:5",
        fileName: "https://cdn.example.test/node_modules/@scope/pkg/bare.js",
        line: 23,
      },
      {
        level: 7,
        method: "<no_method>",
        assembly: "bundle.js:23:5",
        fileName: "bundle.js",
        line: 23,
      },
      {
        level: 8,
        method: "<no_method>",
        assembly: "src/relative.js:24:6",
        fileName: "src/relative.js",
        line: 24,
      },
      {
        level: 9,
        method: "<no_method>",
        assembly: "https://example.test/bootstrap.js:8:3",
        fileName: "https://example.test/bootstrap.js",
        line: 8,
      },
      {
        level: 10,
        method: "<no_method>",
        assembly: "@https://example.test/anonymous.js:12:4",
        fileName: "https://example.test/anonymous.js",
        line: 12,
      },
    ]);
  });

  it("caps the full exception at 64 KB while preserving both ends of the parsed stack", () => {
    const stack = Array.from(
      { length: 700 },
      (_, index) =>
        `    at frame${index} (https://example.test/${"segment/".repeat(12)}file${index}.js:${index + 1}:1)`,
    ).join("\n");
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "Large stack",
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];
    const parsedStack = exception?.parsedStack;
    if (!parsedStack) throw new Error("Expected parsed stack frames");

    expect(new TextEncoder().encode(JSON.stringify(exception)).byteLength).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(exception.stack?.length).toBeLessThan(stack.length);
    expect(parsedStack[0]?.assembly).toContain("frame0");
    expect(parsedStack.at(-1)?.assembly).toContain("frame699");
    expect(parsedStack.length).toBeLessThan(700);
  });

  it("limits parsed stack frame fields to Azure Monitor schema lengths", () => {
    const method = "m".repeat(1100);
    const fileName = `${"path/".repeat(220)}app.js`;
    const stack = `    at ${method} (${fileName}:42:7)`;
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "Long frame",
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const frame = (envelope.data.baseData as ExceptionData).exceptions[0]?.parsedStack?.[0];
    if (!frame) throw new Error("Expected a parsed stack frame");

    expect(frame.method.length).toBe(1024);
    expect(frame.assembly.length).toBe(1024);
    expect(frame.fileName.length).toBe(1024);
  });

  it("applies exception character limits before the aggregate byte limit", () => {
    const typeName = "T".repeat(1024);
    const message = "é".repeat(1024);
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.type": typeName,
          "exception.message": message,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];

    expect(exception.typeName).toBe(typeName);
    expect(exception.message).toBe(message);
  });

  it("reserves raw stack space before allocating a multibyte message", () => {
    const stack = "Error\n    at checkout (https://example.test/app.js:42:7)";
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "😀".repeat(32 * 1024),
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];

    expect(exception.stack).toBe(stack);
    expect(exception.hasFullStack).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(exception)).byteLength).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it("maps an unnamed log to MessageData", () => {
    const envelope = logToEnvelope(
      makeLog({
        body: "cart restored",
        severityNumber: 10,
        attributes: { "url.full": "https://shop.example.test/cart", itemCount: 3 },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "MessageData",
      baseData: {
        ver: 2,
        message: "cart restored",
        severityLevel: 1,
        properties: { "url.full": "https://shop.example.test/cart" },
        measurements: { itemCount: 3 },
      },
    });
  });

  it("maps browser.page_view to PageViewData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.page_view",
        attributes: {
          "browser.page_view.id": "0123456789abcdef0123456789abcdef",
          "browser.page_view.name": "Cart",
          "browser.page_view.duration": 425.25,
          "browser.page_view.referrer": "https://shop.example.test/products",
          "url.full": "https://shop.example.test/cart",
          "browser.page_view.same_document": true,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "PageViewData",
      baseData: {
        ver: 2,
        id: "0123456789abcdef0123456789abcdef",
        name: "Cart",
        url: "https://shop.example.test/cart",
        duration: "00:00:00.4252500",
        referredUri: "https://shop.example.test/products",
        properties: { "browser.page_view.same_document": "true" },
        measurements: undefined,
      },
    });
  });

  it("maps legacy browser.navigation to PageViewData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.navigation",
        attributes: {
          "url.full": "https://shop.example.test/cart",
          "browser.navigation.duration": 425.25,
          "browser.navigation.same_document": true,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "PageViewData",
      baseData: {
        ver: 2,
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        name: "https://shop.example.test/cart",
        url: "https://shop.example.test/cart",
        duration: "00:00:00.4252500",
        properties: { "browser.navigation.same_document": "true" },
        measurements: undefined,
      },
    });
  });

  it.each(["browser.console", "application.audit"])(
    "maps named log %s to MessageData without losing its message or severity",
    (eventName) => {
      const envelope = logToEnvelope(
        makeLog({
          eventName,
          body: "checkout completed",
          severityNumber: 13,
          severityText: "warn",
          attributes: { currency: "USD", total: 42.5, items: ["sku-1", "sku-2"] },
        }),
        instrumentationKey,
      );

      expect(envelope.data).toEqual({
        baseType: "MessageData",
        baseData: {
          ver: 2,
          message: "checkout completed",
          severityLevel: 2,
          properties: {
            currency: "USD",
            items: '["sku-1","sku-2"]',
          },
          measurements: { total: 42.5 },
        },
      });
    },
  );

  it("maps a name-only record to EventData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.user_action.click",
        attributes: { target: "button#add-to-cart" },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: "browser.user_action.click",
        properties: { target: "button#add-to-cart" },
        measurements: undefined,
      },
    });
  });
});

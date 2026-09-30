// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import { MAX_BEACON_BODY_SIZE } from "../../../src/exporter/constants.js";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeLog(overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord {
  return {
    hrTime: [1_735_689_600, 0],
    hrTimeObserved: [1_735_689_600, 0],
    body: "checkout completed",
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    attributes: {},
    droppedAttributesCount: 0,
    ...overrides,
  } as unknown as ReadableLogRecord;
}

function exportLogs(
  exporter: AzureMonitorLogRecordExporter,
  logs: ReadableLogRecord[],
): Promise<{ code: ExportResultCode }> {
  return new Promise((resolve) => exporter.export(logs, resolve));
}

describe("AzureMonitorLogRecordExporter", () => {
  it("maps and exports log records", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });

    const result = await exportLogs(exporter, [makeLog()]);

    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects unload exports that exceed the aggregate beacon body limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    const largeException = makeLog({
      eventName: "exception",
      attributes: {
        "exception.message": "Large exception",
        "exception.stacktrace": Array.from(
          { length: 700 },
          (_, index) =>
            `    at frame${index} (https://example.test/${"segment/".repeat(12)}file${index}.js:${index + 1}:1)`,
        ).join("\n"),
      },
    });
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [largeException, makeLog({ body: "x".repeat(10 * 1024) })]),
      ).resolves.toMatchObject({ code: ExportResultCode.FAILED });
      expect(fetch).not.toHaveBeenCalled();
      expect(sendBeacon).not.toHaveBeenCalled();
    } finally {
      endUnloading();
    }
  });

  it("removes oversized custom fields before unload delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [
          makeLog({
            eventName: "exception",
            attributes: {
              "exception.message": "Large custom field",
              "exception.stacktrace": "Error\n    at checkout (https://example.test/app.js:42:7)",
              payload: "x".repeat(MAX_BEACON_BODY_SIZE),
            },
          }),
        ]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = sendBeacon.mock.calls[0][1] as Blob;
      expect(body.size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
      const envelopes = JSON.parse(await body.text()) as Array<{
        data: {
          baseData: {
            exceptions: Array<{
              message: string;
              stack?: string;
              parsedStack?: unknown[];
            }>;
            properties?: Record<string, string>;
          };
        };
      }>;
      expect(envelopes[0]?.data.baseData.properties?.payload).toBeUndefined();
      expect(envelopes[0]?.data.baseData.exceptions[0]).toMatchObject({
        message: "Large custom field",
        stack: "Error\n    at checkout (https://example.test/app.js:42:7)",
        parsedStack: [expect.objectContaining({ method: "checkout", line: 42 })],
      });
    } finally {
      endUnloading();
    }
  });
});

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

  it("splits unload batches at the beacon body limit", async () => {
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
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(sendBeacon).toHaveBeenCalledTimes(2);
      for (const [, body] of sendBeacon.mock.calls) {
        expect((body as Blob).size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
      }
    } finally {
      endUnloading();
    }
  });
});

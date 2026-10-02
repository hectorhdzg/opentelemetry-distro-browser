// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/shared/constants.js";

const instrumentationKey = "00000000-0000-0000-0000-000000000000";
const spanContext: SpanContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
};
const parentSpanContext: SpanContext = {
  ...spanContext,
  spanId: "fedcba9876543210",
};
const resource = { attributes: { "service.name": "browser-store" } };

function makeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "GET /items/:id",
    kind: SpanKind.CLIENT,
    spanContext: () => spanContext,
    parentSpanContext,
    startTime: [1_735_689_600, 0],
    endTime: [1_735_689_601, 234_567_000],
    duration: [1, 234_567_000],
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    resource,
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ended: true,
    ...overrides,
  } as unknown as ReadableSpan;
}

describe("Azure Monitor span envelope mapping", () => {
  it("maps an HTTP client span to RemoteDependencyData", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.request.method": "GET",
          "http.response.status_code": 503,
          "server.address": "api.example.test",
          "server.port": 8443,
          "url.full": "https://api.example.test:8443/items/42?source=test",
          tenant: "north",
          retries: 2,
        },
      }),
      instrumentationKey,
    );

    expect(envelope).toEqual({
      name: "Microsoft.ApplicationInsights.RemoteDependency",
      time: "2025-01-01T00:00:00.000Z",
      iKey: instrumentationKey,
      sampleRate: 100,
      tags: {
        "ai.internal.sdkVersion": `mot${OPENTELEMETRY_BROWSER_VERSION}`,
        "ai.operation.id": spanContext.traceId,
        "ai.operation.parentId": parentSpanContext.spanId,
        "ai.cloud.role": "browser-store",
      },
      ver: 1,
      data: {
        baseType: "RemoteDependencyData",
        baseData: {
          ver: 2,
          id: spanContext.spanId,
          name: "GET /items/42",
          duration: "00:00:01.2345670",
          success: false,
          resultCode: "503",
          type: "Http",
          data: "https://api.example.test:8443/items/42?source=test",
          target: "api.example.test:8443",
          properties: { tenant: "north" },
          measurements: { retries: 2 },
        },
      },
    });
  });

  it.each(["user.id", "enduser.id"])(
    "maps %s to authenticated user context and promotes user tags",
    (attribute) => {
      const envelope = spanToEnvelope(
        makeSpan({
          attributes: {
            [attribute]: "signed-in-user",
            "enduser.pseudo.id": "anonymous-user",
            "user.account.id": "tenant-42",
          },
        }),
        instrumentationKey,
      );

      expect(envelope.tags).toMatchObject({
        "ai.user.id": "anonymous-user",
        "ai.user.authUserId": "signed-in-user",
        "ai.user.accountId": "tenant-42",
      });
      expect(envelope.data.baseData.properties).toBeUndefined();
    },
  );

  it("prefers application enduser.id over managed user.id", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "user.id": "managed-user",
          "enduser.id": "application-user",
        },
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.user.authUserId"]).toBe("application-user");
    expect(envelope.data.baseData.properties).toBeUndefined();
  });

  it("uses the same authenticated user precedence for resource attributes", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        resource: resourceFromAttributes({
          "user.id": "managed-user",
          "enduser.id": "application-user",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.user.authUserId"]).toBe("application-user");
  });

  it("omits invalid user tag values", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "enduser.pseudo.id": "",
          "user.id": null,
          "user.account.id": 42,
        } as unknown as ReadableSpan["attributes"],
      }),
      instrumentationKey,
    );

    expect(envelope.tags).not.toHaveProperty("ai.user.id");
    expect(envelope.tags).not.toHaveProperty("ai.user.authUserId");
    expect(envelope.tags).not.toHaveProperty("ai.user.accountId");
  });

  it("falls back to valid resource user context when signal values are invalid", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "enduser.pseudo.id": "",
          "enduser.id": null,
          "user.account.id": 42,
        } as unknown as ReadableSpan["attributes"],
        resource: resourceFromAttributes({
          "enduser.pseudo.id": "resource-anonymous",
          "enduser.id": "resource-user",
          "user.account.id": "resource-account",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags).toMatchObject({
      "ai.user.id": "resource-anonymous",
      "ai.user.authUserId": "resource-user",
      "ai.user.accountId": "resource-account",
    });
  });

  it("maps a server span to RequestData", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        name: "GET /checkout",
        kind: SpanKind.SERVER,
        attributes: {
          "http.response.status_code": 204,
          "url.full": "https://shop.example.test/checkout",
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "RequestData",
      baseData: {
        ver: 2,
        id: spanContext.spanId,
        name: "GET /checkout",
        duration: "00:00:01.2345670",
        success: true,
        responseCode: "204",
        url: "https://shop.example.test/checkout",
        properties: undefined,
        measurements: undefined,
      },
    });
  });

  it("includes the day component for long span durations", () => {
    const envelope = spanToEnvelope(
      makeSpan({ duration: [90_061, 1_000_000] }),
      instrumentationKey,
    );

    expect(envelope.data.baseData.duration).toBe("1.01:01:01.0010000");
  });
});

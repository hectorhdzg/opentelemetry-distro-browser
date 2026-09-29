// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Attributes } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_NAME,
  EVENT_BROWSER_PAGE_VIEW,
} from "../instrumentation/pageView/semconv.js";
import {
  createEnvelope,
  createTags,
  hrTimeToDate,
  mapAttributes,
  millisecondsToTimeSpan,
  serializeAttribute,
} from "./common.js";
import {
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  NAVIGATION_DURATION,
  NAVIGATION_EVENT_NAME,
  URL_FULL,
} from "./constants.js";
import type {
  AzureMonitorEnvelope,
  CustomEventData,
  ExceptionData,
  MessageData,
  PageViewData,
  SeverityLevel,
  StackFrame,
} from "./telemetryModels.js";

const promotedLogAttributes = /* @__PURE__ */ new Set([
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  NAVIGATION_DURATION,
]);
const promotedPageViewAttributes = /* @__PURE__ */ new Set([
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  NAVIGATION_DURATION,
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_NAME,
  URL_FULL,
]);

function isPageView(eventName: string | undefined): boolean {
  return eventName === EVENT_BROWSER_PAGE_VIEW || eventName === NAVIGATION_EVENT_NAME;
}

function mapSeverity(severityNumber: number | undefined): SeverityLevel | undefined {
  if (!severityNumber || severityNumber < 1 || severityNumber > 24) return undefined;
  if (severityNumber < 9) return 0;
  if (severityNumber < 13) return 1;
  if (severityNumber < 17) return 2;
  if (severityNumber < 21) return 3;
  return 4;
}

function parseStack(stack: string): readonly StackFrame[] | undefined {
  const frames: StackFrame[] = [];

  for (const assembly of stack.split("\n")) {
    const trimmed = assembly.trim();
    const location = /:(\d+):\d+\)?$/.exec(trimmed) ?? /:(\d+)\)?$/.exec(trimmed);
    if (!location) continue;

    const prefix = trimmed.slice(0, location.index);
    const openParenthesis = prefix.lastIndexOf("(");
    const atSign = prefix.indexOf("@");
    const scheme = prefix.indexOf("://");
    const separator =
      openParenthesis >= 0 ? openParenthesis : atSign >= 0 && atSign < scheme ? atSign : -1;
    const method =
      separator < 0
        ? "<no_method>"
        : prefix
            .slice(0, separator)
            .replace(/^\s*at\s+/, "")
            .trim() || "<no_method>";
    const fileName = (separator < 0 ? prefix : prefix.slice(separator + 1))
      .replace(/^\s*at\s+/, "")
      .trim();
    if (!fileName) continue;

    frames.push({
      level: frames.length,
      method,
      assembly: trimmed,
      fileName,
      line: Number(location[1]),
    });
  }

  return frames.length === 0 ? undefined : frames;
}

export function logToEnvelope(
  logRecord: ReadableLogRecord,
  instrumentationKey: string,
): AzureMonitorEnvelope<MessageData | ExceptionData | PageViewData | CustomEventData> {
  const customFields = mapAttributes(
    logRecord.attributes as Attributes,
    isPageView(logRecord.eventName) ? promotedPageViewAttributes : promotedLogAttributes,
  );
  const tags = createTags(
    logRecord.spanContext?.traceId,
    logRecord.spanContext?.spanId,
    logRecord.resource.attributes["service.name"],
  );
  const severityLevel = mapSeverity(logRecord.severityNumber);
  let name: string;
  let baseType: AzureMonitorEnvelope["data"]["baseType"];
  let baseData: MessageData | ExceptionData | PageViewData | CustomEventData;

  if (logRecord.eventName === "exception" || logRecord.attributes[EXCEPTION_TYPE]) {
    const stack = logRecord.attributes[EXCEPTION_STACKTRACE];
    const serializedStack = stack === undefined ? undefined : serializeAttribute(stack);
    name = "Microsoft.ApplicationInsights.Exception";
    baseType = "ExceptionData";
    baseData = {
      ver: 2,
      exceptions: [
        {
          typeName: serializeAttribute(logRecord.attributes[EXCEPTION_TYPE] ?? "Error"),
          message: serializeAttribute(
            logRecord.attributes[EXCEPTION_MESSAGE] ?? logRecord.body ?? "Exception",
          ),
          hasFullStack: Boolean(stack),
          stack: serializedStack,
          parsedStack: serializedStack === undefined ? undefined : parseStack(serializedStack),
        },
      ],
      severityLevel,
      ...customFields,
    };
  } else if (isPageView(logRecord.eventName)) {
    const duration =
      logRecord.attributes[ATTR_PAGE_VIEW_DURATION] ?? logRecord.attributes[NAVIGATION_DURATION];
    name = "Microsoft.ApplicationInsights.PageView";
    baseType = "PageViewData";
    baseData = {
      ver: 2,
      name: serializeAttribute(
        logRecord.body ??
          logRecord.attributes[ATTR_PAGE_VIEW_NAME] ??
          logRecord.attributes[URL_FULL] ??
          "Page View",
      ),
      url:
        logRecord.attributes[URL_FULL] === undefined
          ? undefined
          : serializeAttribute(logRecord.attributes[URL_FULL]),
      duration: typeof duration === "number" ? millisecondsToTimeSpan(duration) : undefined,
      ...customFields,
    };
  } else if (
    logRecord.eventName &&
    logRecord.body === undefined &&
    logRecord.severityNumber === undefined
  ) {
    name = "Microsoft.ApplicationInsights.Event";
    baseType = "EventData";
    baseData = {
      ver: 2,
      name: logRecord.eventName,
      ...customFields,
    };
  } else {
    name = "Microsoft.ApplicationInsights.Message";
    baseType = "MessageData";
    baseData = {
      ver: 2,
      message: serializeAttribute(logRecord.body ?? ""),
      severityLevel,
      ...customFields,
    };
  }

  return createEnvelope(
    instrumentationKey,
    name,
    hrTimeToDate(logRecord.hrTime),
    tags,
    baseType,
    baseData,
  );
}

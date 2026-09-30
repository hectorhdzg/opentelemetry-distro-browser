// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Attributes } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { generatePageViewId } from "../instrumentation/pageView/pageViewContext.js";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_REFERRER,
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
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_REFERRER,
  URL_FULL,
]);
const MAX_EXCEPTION_SIZE_IN_BYTES = 64 * 1024;
const MAX_EXCEPTION_TYPE_SIZE_IN_BYTES = 1024;
const MAX_EXCEPTION_MESSAGE_SIZE_IN_BYTES = 32 * 1024;
const MAX_EXCEPTION_STACK_SIZE_IN_BYTES = 32 * 1024;
const MAX_PARSED_STACK_SIZE_IN_BYTES = 32 * 1024;
const MAX_STACK_FRAME_FIELD_LENGTH = 1024;
const STACK_PROPERTY_SIZE_IN_BYTES = 9;
const PARSED_STACK_PROPERTY_SIZE_IN_BYTES = 15;
let textEncoder: TextEncoder | undefined;

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

function getUtf8Size(value: string): number {
  textEncoder ??= new TextEncoder();
  return textEncoder.encode(value).byteLength;
}

function truncateToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function truncateJsonStringToSize(value: string, maxSizeInBytes: number): string | undefined {
  if (maxSizeInBytes < 2) return undefined;
  if (getUtf8Size(JSON.stringify(value)) <= maxSizeInBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (getUtf8Size(JSON.stringify(truncateToLength(value, middle))) <= maxSizeInBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return truncateToLength(value, low);
}

function parseStack(stack: string, maxSizeInBytes: number): readonly StackFrame[] | undefined {
  const frames: StackFrame[] = [];

  for (const assembly of stack.split("\n")) {
    const trimmed = assembly.trim();
    const locationWithColumn = /:(\d+):\d+\)?$/.exec(trimmed);
    const location = locationWithColumn ?? /:(\d+)\)?$/.exec(trimmed);
    if (!location) continue;

    const startsWithAt = trimmed.startsWith("at ");
    const atSign = trimmed.indexOf("@");
    const scheme = trimmed.indexOf("://");
    const atSource =
      atSign >= 0 && atSign < location.index ? trimmed.slice(atSign + 1, location.index) : "";
    const isLikelyCodeSource =
      atSource.includes("://") ||
      atSource.includes("/") ||
      atSource.includes("\\") ||
      /\.(?:[cm]?js|jsx|ts|tsx|wasm|html?)$/i.test(atSource);
    const hasAtLocation =
      !startsWithAt && atSign >= 0 && atSign < location.index && isLikelyCodeSource;
    const isBareUrlLocation = scheme > 0 && !trimmed.slice(0, scheme).includes(" ");
    if (!startsWithAt && !hasAtLocation && !isBareUrlLocation) continue;

    const prefix = trimmed.slice(0, location.index);
    const openParenthesis = prefix.indexOf(" (");
    let method = "<no_method>";
    let fileName = prefix.replace(/^\s*at\s+/, "").trim();
    if (openParenthesis >= 0) {
      method =
        prefix
          .slice(0, openParenthesis)
          .replace(/^\s*at\s+/, "")
          .trim() || method;
      fileName = prefix.slice(openParenthesis + 2).trim();
    } else if (hasAtLocation) {
      method =
        prefix
          .slice(0, atSign)
          .replace(/^\s*at\s+/, "")
          .trim() || method;
      fileName = prefix.slice(atSign + 1).trim();
    } else if (startsWithAt) {
      const separator = fileName.lastIndexOf(" ");
      if (separator >= 0) {
        method = fileName.slice(0, separator).trim() || method;
        fileName = fileName.slice(separator + 1).trim();
      }
    }
    if (!fileName) continue;

    frames.push({
      level: frames.length,
      method: truncateToLength(method, MAX_STACK_FRAME_FIELD_LENGTH),
      assembly: truncateToLength(trimmed, MAX_STACK_FRAME_FIELD_LENGTH),
      fileName: truncateToLength(fileName, MAX_STACK_FRAME_FIELD_LENGTH),
      line: Number(location[1]),
    });
  }

  if (frames.length === 0) return undefined;

  const sizes = frames.map((frame) => getUtf8Size(JSON.stringify(frame)));
  const serializedSize = 2 + sizes.reduce((sum, size) => sum + size, 0) + frames.length - 1;
  if (serializedSize <= maxSizeInBytes) return frames;

  const first: StackFrame[] = [];
  const last: StackFrame[] = [];
  let selectedSize = 2;
  let left = 0;
  let right = frames.length - 1;
  while (left <= right) {
    const isPair = left !== right;
    const addedSize =
      sizes[left] +
      (isPair ? sizes[right] : 0) +
      (first.length + last.length === 0 ? 0 : 1) +
      (isPair ? 1 : 0);
    if (selectedSize + addedSize > maxSizeInBytes) break;
    first.push(frames[left]);
    if (isPair) last.push(frames[right]);
    selectedSize += addedSize;
    left++;
    right--;
  }

  const capped = [...first, ...last.reverse()];
  return capped.length === 0 ? undefined : capped;
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
    const exceptionWithoutStack = {
      typeName:
        truncateJsonStringToSize(
          serializeAttribute(logRecord.attributes[EXCEPTION_TYPE] ?? "Error"),
          MAX_EXCEPTION_TYPE_SIZE_IN_BYTES,
        ) ?? "",
      message:
        truncateJsonStringToSize(
          serializeAttribute(
            logRecord.attributes[EXCEPTION_MESSAGE] ?? logRecord.body ?? "Exception",
          ),
          MAX_EXCEPTION_MESSAGE_SIZE_IN_BYTES,
        ) ?? "",
      hasFullStack: Boolean(stack),
    };
    const stackSize = Math.min(
      MAX_EXCEPTION_STACK_SIZE_IN_BYTES,
      MAX_EXCEPTION_SIZE_IN_BYTES -
        getUtf8Size(JSON.stringify(exceptionWithoutStack)) -
        STACK_PROPERTY_SIZE_IN_BYTES,
    );
    const emittedStack =
      serializedStack === undefined
        ? undefined
        : truncateJsonStringToSize(serializedStack, stackSize);
    const exception = {
      ...exceptionWithoutStack,
      stack: emittedStack,
    };
    const parsedStackSize = Math.min(
      MAX_PARSED_STACK_SIZE_IN_BYTES,
      MAX_EXCEPTION_SIZE_IN_BYTES -
        getUtf8Size(JSON.stringify(exception)) -
        PARSED_STACK_PROPERTY_SIZE_IN_BYTES,
    );
    const parsedStack =
      serializedStack === undefined || parsedStackSize < 2
        ? undefined
        : parseStack(serializedStack, parsedStackSize);
    name = "Microsoft.ApplicationInsights.Exception";
    baseType = "ExceptionData";
    baseData = {
      ver: 2,
      exceptions: [
        {
          ...exception,
          parsedStack,
        },
      ],
      severityLevel,
      ...customFields,
    };
  } else if (isPageView(logRecord.eventName)) {
    const duration =
      logRecord.attributes[ATTR_PAGE_VIEW_DURATION] ?? logRecord.attributes[NAVIGATION_DURATION];
    const pageViewId = logRecord.attributes[ATTR_PAGE_VIEW_ID];
    const referrer = logRecord.attributes[ATTR_PAGE_VIEW_REFERRER];
    name = "Microsoft.ApplicationInsights.PageView";
    baseType = "PageViewData";
    baseData = {
      ver: 2,
      id: pageViewId === undefined ? generatePageViewId() : serializeAttribute(pageViewId),
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
      ...(referrer === undefined ? {} : { referredUri: serializeAttribute(referrer) }),
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

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
} from "../user/constants.js";
import type { UserContextProvider } from "../user/createUserContext.js";

export interface BrowserContextProvider extends UserContextProvider {
  getSessionId(): string | null;
}

function enrich(
  attributes: Readonly<Record<string, unknown>>,
  setAttribute: (name: string, value: string) => void,
  provider: BrowserContextProvider,
): void {
  if (attributes["session.id"] === undefined) {
    const sessionId = provider.getSessionId();
    if (sessionId !== null) setAttribute("session.id", sessionId);
  }
  if (attributes[ATTR_ENDUSER_PSEUDO_ID] === undefined) {
    setAttribute(ATTR_ENDUSER_PSEUDO_ID, provider.getAnonymousUserId());
  }
  if (attributes[ATTR_USER_ID] === undefined && attributes[ATTR_ENDUSER_ID] === undefined) {
    const userId = provider.getAuthenticatedUserId();
    if (userId !== undefined) setAttribute(ATTR_USER_ID, userId);
  }
  if (attributes[ATTR_USER_ACCOUNT_ID] === undefined) {
    const accountId = provider.getAccountId();
    if (accountId !== undefined) setAttribute(ATTR_USER_ACCOUNT_ID, accountId);
  }
}

export class BrowserContextSpanProcessor implements SpanProcessor {
  public constructor(private readonly provider: BrowserContextProvider) {}

  public onStart(span: Span): void {
    enrich(span.attributes, (name, value) => span.setAttribute(name, value), this.provider);
  }

  public onEnd(): void {}

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export class BrowserContextLogRecordProcessor {
  public constructor(private readonly provider: BrowserContextProvider) {}

  public enabled(): boolean {
    return false;
  }

  public onEmit(record: ReadWriteLogRecord): void {
    enrich(record.attributes, (name, value) => record.setAttribute(name, value), this.provider);
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

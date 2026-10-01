// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, expect, it } from "vitest";
import { getSdkLoaderScript } from "../../../src/snippet.js";

type LoaderWindow = typeof window & {
  Microsoft?: {
    OpenTelemetry: {
      useMicrosoftOpenTelemetry(options: unknown): Promise<unknown>;
    };
  };
  microsoftOpenTelemetry?: Promise<unknown>;
  snippetOptions?: unknown;
};

const loaderWindow = window as LoaderWindow;

afterEach(() => {
  delete loaderWindow.Microsoft;
  delete loaderWindow.microsoftOpenTelemetry;
  delete loaderWindow.snippetOptions;
});

it("requires an explicit bundle URL and connection string", () => {
  expect(() => getSdkLoaderScript({ src: "", connectionString: "connection" })).toThrow(
    "SdkLoaderConfig.src must be a non-empty string.",
  );
  expect(() =>
    getSdkLoaderScript({ src: "https://example.test/sdk.js", connectionString: "" }),
  ).toThrow("SdkLoaderConfig.connectionString must be a non-empty string.");
});

it("loads the configured bundle and exposes asynchronous initialization", async () => {
  const bundle = new Blob(
    [
      `window.Microsoft={OpenTelemetry:{useMicrosoftOpenTelemetry:function(options){` +
        `window.snippetOptions=options;return Promise.resolve({forceFlush:function(){}})}}};`,
    ],
    { type: "text/javascript" },
  );
  const src = URL.createObjectURL(bundle);
  const script = document.createElement("script");
  script.text = getSdkLoaderScript({
    src,
    connectionString: "InstrumentationKey=test",
  });
  document.head.append(script);

  try {
    await expect(loaderWindow.microsoftOpenTelemetry).resolves.toMatchObject({
      forceFlush: expect.any(Function),
    });
    expect(loaderWindow.snippetOptions).toEqual({
      azureMonitor: { connectionString: "InstrumentationKey=test" },
    });
  } finally {
    script.remove();
    Array.from(document.scripts)
      .find((candidate) => candidate.src === src)
      ?.remove();
    URL.revokeObjectURL(src);
  }
});

it("escapes values embedded in an inline script", () => {
  const generated = getSdkLoaderScript({
    src: "https://example.test/sdk.js",
    connectionString: "</script>\u2028",
  });

  expect(generated).not.toContain("</script>");
  expect(generated).toContain("\\u003c/script\\u003e\\u2028");
});

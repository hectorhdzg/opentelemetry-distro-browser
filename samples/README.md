# Browser samples

These applications consume the published
`@microsoft/opentelemetry-browser@0.1.0-alpha.1` package, following the same
self-contained sample pattern as the Microsoft OpenTelemetry Node.js distribution.

| Sample              | Purpose                                                                          | Command               |
| ------------------- | -------------------------------------------------------------------------------- | --------------------- |
| [Console](console/) | Start locally without a telemetry backend and inspect spans and logs in DevTools | `npm run dev:console` |
| [OTLP](otlp/)       | Export browser spans and logs to an OTLP/HTTP collector                          | `npm run dev:otlp`    |

Install dependencies once from this directory:

```bash
npm install
```

Each sample initializes telemetry before dynamically importing application code. This ordering is
important because browser instrumentations must patch APIs such as `fetch` before the application
uses them.

## OTLP configuration

Copy `.env.example` to `.env.local`, set `VITE_OTLP_ENDPOINT` to the collector's OTLP/HTTP base
URL, and run `npm run dev:otlp`. The sample appends `/v1/traces` and `/v1/logs`.

The collector must allow the sample origin through CORS. `VITE_` values are public browser
configuration; never put API keys, bearer tokens, or other secrets in them. Use a collector or
gateway to authenticate browser traffic.

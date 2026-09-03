# OpenTelemetry Browser Distribution Implementation Plan

**Status:** Proposed  
**Approach:** Greenfield browser distribution built on upstream OpenTelemetry APIs  
**Prior evidence:** Multi-instance browser PoC (`cfef8c8`)  
**Planning reference:** [`microsoft/ApplicationInsights-JS` OTel SDK planning](https://github.com/microsoft/ApplicationInsights-JS/tree/otel-sdk/shared/otel-core/planning)

## 1. Goal

Build a vendor-neutral OpenTelemetry distribution for browser applications.
The distribution will use the upstream `@opentelemetry/api` and OpenTelemetry
JavaScript SDK contracts while solving browser-specific composition,
multi-instance isolation, instrumentation ownership, lifecycle, performance, and
packaging problems.

The product is **not** a new Application Insights SDK and is **not** a migration
of `ApplicationInsights-JS`. Application Insights, Azure Monitor, OTLP, and
other destinations are exporters or optional bridges connected to the standard
OpenTelemetry pipeline.

Applications and third-party libraries should continue to use normal
OpenTelemetry APIs. Existing upstream instrumentations, processors, exporters,
samplers, propagators, resources, and context types should connect directly
where the upstream contracts permit it and through narrow adapters only where a
browser or multi-instance boundary requires one.

## 2. Product Principles

| Principle | Decision |
|---|---|
| Upstream API first | `@opentelemetry/api` is the canonical telemetry API. Do not create a parallel tracing API or duplicate OTel interfaces. |
| Vendor neutral | Core packages contain no Application Insights schema, connection strings, tracking APIs, or backend assumptions. |
| Multi-instance | Independently configured consumers can coexist in one JavaScript realm without crossing telemetry pipelines. |
| One global router | Install one global routing provider and route tracer acquisition to isolated instance providers. |
| Bound tracers | Select an instance when `getTracer()` runs; the returned tracer remains bound to that instance. |
| Standard extensions | Prefer standard OTel instrumentations and SDK extension points over distribution-specific plugins. |
| Bridges are narrow | Add adapters only for lifecycle, routing, shared browser patches, or incompatible third-party contracts. |
| Explicit ownership | Every instrumentation, patch, timer, listener, processor, exporter, and provider has an owner and cleanup path. |
| No silent fallback | Invalid routing, duplicate globals, unsupported instrumentation combinations, and lifecycle failures are diagnosed clearly. |
| Greenfield | Reuse lessons and upstream packages, not the existing Application Insights SDK architecture. |

## 3. Prior PoC Findings

The repository's multi-instance PoC proved a useful minimum:

- One provider can be registered with the real `@opentelemetry/api` and route
  tracers to multiple logical SDK instances.
- Instance selection can occur during `trace.getTracer()` using an upstream
  `Context` value.
- A returned tracer can retain its instance permanently, avoiding mutable
  global routing during span creation.
- Two consumers can use the same instrumentation scope while keeping spans in
  separate pipelines.
- Upstream `DocumentLoadInstrumentation` instances can acquire differently
  bound tracers when initialized inside the correct instance boundary.
- Parent-child relationships can survive `await` when callers explicitly carry
  and pass an upstream `Context`.

The PoC did **not** prove:

- delegation to production upstream `TracerProvider` pipelines;
- automatic asynchronous context propagation;
- per-instance shutdown and stale-tracer behavior;
- safe use of multiple instrumentations that patch the same browser API;
- W3C propagation and baggage;
- coexistence with a previously installed global OTel SDK;
- duplicate `@opentelemetry/api` packages, iframes, workers, or module federation.

These findings are the starting point of this plan, not discarded prototype
work.

## 4. Scope

### Initial release

- A global multi-instance routing layer built against `@opentelemetry/api`.
- Isolated per-instance upstream tracing pipelines.
- Explicit instance creation, initialization, lookup, flush, and shutdown.
- Manual tracing through the standard OTel API.
- W3C Trace Context and Baggage propagation.
- A supported way to attach upstream OTel processors and exporters.
- A supported way to initialize upstream browser instrumentations.
- Safe ownership rules for shared browser patches.
- OTLP trace export as the vendor-neutral reference path.
- ESM-first npm packages and browser bundles from the same source.
- Browser integration, compatibility, lifecycle, performance, and bundle tests.

### Later signals and capabilities

- Logs after browser API/SDK maturity and multi-instance routing are validated.
- Metrics after aggregation, temporality, cardinality, and export semantics are
  designed.
- Dynamic instrumentation loading and unloading.
- Optional backend-specific exporter bundles.
- Optional compatibility bridges for legacy SDK APIs.
- CDN loader, snippet queue, and unsupported-browser behavior.
- Workers and iframe coordination beyond independently initialized realms.

### Non-goals

- Reimplementing the OpenTelemetry API or SDK.
- Building an Application Insights SDK.
- Making a legacy Application Insights API the primary user surface.
- Coupling core routing to a telemetry backend or wire format.
- Transparently supporting every browser instrumentation in the first release.
- Claiming arbitrary multi-instance auto-instrumentation is safe before shared
  patch behavior is proven.
- Hiding unavoidable global OTel constraints from users.

## 5. Architecture

```text
Applications and upstream instrumentations
                    |
                    | @opentelemetry/api
                    v
          one global RoutingTracerProvider
                    |
          instance selected at getTracer()
              /                     \
             v                       v
     instance-bound tracer A  instance-bound tracer B
             |                       |
             v                       v
     upstream provider A      upstream provider B
     sampler/processors       sampler/processors
     resource/exporters       resource/exporters
             |                       |
             v                       v
       any OTel exporter       any OTel exporter
```

### 5.1 Global bridge

The global bridge owns the single registration with `@opentelemetry/api`.
It contains:

- the routing `TracerProvider`;
- an instance registry;
- the instance-selection context key;
- global ownership and conflict diagnostics;
- instrumentation initialization boundaries;
- coordinated bridge shutdown.

The bridge does not own backend configuration or implement span recording.

### 5.2 Instance

Each instance owns an independent upstream SDK pipeline:

- stable instance ID;
- resource;
- sampler;
- tracer provider;
- span processors;
- exporters;
- instrumentation registrations;
- propagator and context policy;
- lifecycle state and diagnostics.

An instance must never read configuration or pipeline state from another
instance.

### 5.3 Routing provider and bound tracer

`RoutingTracerProvider.getTracer()` resolves the current instance and delegates
to that instance's upstream provider. It returns a tracer permanently associated
with the selected instance/provider.

Production behavior must define:

- unknown or missing instance selection;
- tracer acquisition before instance start;
- tracer use after instance shutdown;
- instance replacement and ID reuse;
- instrumentation scope caching;
- provider and bridge shutdown races.

The default for missing selection should be explicit and observable. Whether it
throws, returns a non-recording tracer, or routes to a configured default
instance is an API decision to settle before implementation.

### 5.4 Instrumentation bridge

Many upstream instrumentations cache a tracer at initialization and patch
realm-wide browser APIs. The bridge must distinguish two concerns:

1. **Tracer binding:** initialize the instrumentation inside an instance
   selection boundary and provide that instance's routed provider.
2. **Patch ownership:** prevent unsafe duplicate wrapping of shared APIs such as
   `fetch`, XHR, History, and event listeners.

The bridge should accept upstream `InstrumentationOption` values. It must not
invent a second general-purpose instrumentation interface.

Potential shared-patch models to evaluate:

- one instrumentation owner routes produced spans according to active instance;
- one patch fans out to explicitly selected instance pipelines;
- only one instance may own a given patch type;
- unsupported multi-owner combinations fail during initialization.

Do not choose a universal model before the fetch/XHR spike establishes its
correctness and context behavior.

### 5.5 Context

The design has two separate context needs:

- selecting an instance while a tracer or instrumentation is initialized;
- carrying active span context during application work.

Both use upstream `Context`; neither should introduce a proprietary context
object. Because browser async context propagation is incomplete, support must
be stated precisely:

- synchronous `context.with()` behavior;
- explicit context passed across `await`;
- callbacks bound through an enabled context manager;
- instrumentation-specific propagation behavior;
- future platform mechanisms only after browser support is sufficient.

### 5.6 Export

Instance pipelines accept standard OTel `SpanProcessor` and exporter contracts.
OTLP is the initial end-to-end reference exporter because it keeps the
distribution backend-neutral.

Azure Monitor/Application Insights, Zipkin, Jaeger-compatible gateways, vendor
agents, and custom collectors are integrations, not core architecture.

## 6. Proposed Packages

Names are provisional.

| Package | Responsibility |
|---|---|
| `@microsoft/otel-browser` | Public distribution factory, defaults, instance lifecycle, and convenience composition. |
| `@microsoft/otel-browser-router` | Global provider, instance registry, bound tracers, and routing lifecycle. |
| `@microsoft/otel-browser-instrumentation` | Upstream instrumentation initialization and shared-patch ownership. |
| `@microsoft/otel-browser-testing` | Test exporters, fixtures, browser harnesses, and conformance helpers. |
| `@microsoft/otel-browser-loader` | Deferred CDN loading and unsupported-browser policy. |

Backend exporters should remain their existing upstream/vendor packages whenever
possible. A backend-specific bridge belongs in a separate package and must
depend on the distribution, never the reverse.

## 7. Public API Direction

The distribution API manages instances while exposing upstream types:

```ts
import type {
  ContextManager,
  TextMapPropagator,
} from "@opentelemetry/api";
import type { InstrumentationOption } from "@opentelemetry/instrumentation";
import type {
  Sampler,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Resource } from "@opentelemetry/resources";

export interface BrowserTelemetryInstanceConfig {
  id: string;
  resource?: Resource;
  sampler?: Sampler;
  spanProcessors?: SpanProcessor[];
  exporters?: SpanExporter[];
  propagator?: TextMapPropagator;
  contextManager?: ContextManager;
  instrumentations?: InstrumentationOption[];
}

export interface ResolvedBrowserTelemetryInstanceConfig {
  readonly id: string;
  readonly resource: Resource;
  readonly sampler: Sampler;
  readonly spanProcessors: readonly SpanProcessor[];
  readonly propagator: TextMapPropagator;
  readonly contextManager: ContextManager;
  readonly instrumentations: readonly InstrumentationOption[];
}

export interface BrowserTelemetryInstanceStats {
  readonly state: "created" | "starting" | "running" | "stopping" | "stopped";
  readonly activeInstrumentationCount: number;
  readonly droppedSpanCount: number;
  readonly lastFlushResult?: "success" | "failure" | "timeout";
}

export interface BrowserTelemetryDistributionInfo {
  readonly version: string;
  readonly apiVersion: string;
  readonly loadMethod: "npm" | "cdn" | "dynamic";
}

export interface BrowserTelemetryInstance {
  readonly id: string;
  start(): Promise<void>;
  run<T>(callback: () => T): T;
  getConfigSnapshot(): Readonly<ResolvedBrowserTelemetryInstanceConfig>;
  getStats(): Readonly<BrowserTelemetryInstanceStats>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BrowserTelemetryDistribution {
  readonly info: BrowserTelemetryDistributionInfo;
  createInstance(
    config: BrowserTelemetryInstanceConfig,
  ): BrowserTelemetryInstance;
  getInstance(id: string): BrowserTelemetryInstance | undefined;
  hasInstance(id: string): boolean;
  listInstanceIds(): readonly string[];
  getInstanceCount(): number;
  shutdown(): Promise<void>;
}

export function createBrowserTelemetryDistribution():
  BrowserTelemetryDistribution;
```

This is a design sketch, not a committed API. Phase 0 must align exact contracts
with the selected upstream package versions and decide whether exporters are
wrapped into processors automatically or processors remain the only pipeline
input.

Later management APIs must retain upstream instrumentation types while exposing
owned lifecycle operations:

```ts
export interface BrowserInstrumentationManager {
  load(
    id: string,
    instrumentation: InstrumentationOption,
  ): Promise<InstrumentationLoadResult>;
  get(id: string): InstrumentationOption | undefined;
  list(): readonly InstrumentationRegistration[];
  isLoaded(id: string): boolean;
  unload(id: string): Promise<void>;
}

export interface TelemetryTransformRegistration {
  remove(): void;
}
```

The transform/filter contract must define signal type, synchronous execution,
ordering, rejection, mutation versus replacement, exception behavior, and cost
budget before it becomes public.

## 8. Prior Plan Reconciliation

The previous planning set remains an input to this project. Requirements are
retained when they are product qualities independent of the old implementation.
Conflicting requirements are not silently discarded; the replacement approach
is recorded below.

### 8.1 Requirements retained and tracked

| Previous requirement area | Treatment in this plan | Tracking location |
|---|---|---|
| Web-optimized distribution | Retained. Core, router, instrumentations, loader, and integrations have independent bundle budgets and tree-shaking tests. | Phase 1; Packaging and bundle size |
| ES2020+ full SDK | Retained as the initial candidate build target, subject to measured customer/browser requirements. | Browser and loader policy |
| ES2015 loader and pre-ES2015 fallback | Retained as an explicit product decision. If approved, the full SDK is never downloaded on unsupported browsers; the loader either skips it or selects a separate no-op package. | Phase 8; Browser and loader policy |
| No no-op code in the full SDK | Retained. Unsupported-runtime stubs belong in a separate package selected by the loader. | Packaging and bundle size |
| Multi-instance and multi-team isolation | Retained and elevated to the core architecture. Includes discovery, duplicate-name rejection, independent flush/shutdown, and coordinated shutdown. | Phases 0, 2, and 6 |
| Complete unload | Retained. Hooks, patches, listeners, timers, providers, processors, exporters, queues, and config subscriptions require explicit owners and cleanup. | Phase 2; Lifecycle; Testing |
| Dependency injection | Retained for per-instance resources, sampler, processors, exporters, propagator, context policy, diagnostics, clocks, and platform hooks. | Public API; Configuration |
| Configuration validation | Retained. Required and mutually exclusive options are validated before side effects. | Phases 1 and 2 |
| Dynamic configuration | Retained as a later capability, not assumed for every field. Each mutable option needs atomic apply, rollback, ownership, and cleanup semantics. | Phase 7; Configuration |
| Runtime instrumentation management | Retained after shared-patch ownership is solved. Includes load, lookup, list, enable/disable, unload, and failure results. | Phases 4 and 7 |
| Third-party instrumentations | Retained through upstream `InstrumentationOption` and provider contracts rather than a new plugin model. | Phase 4 |
| A/B instrumentation switching | Retained as a Phase 7 acceptance scenario after safe unload is available. | Phase 7 |
| Trace processing and sampling | Retained through upstream samplers, processors, exporters, resources, and ID generators. | Phases 2 and 5 |
| W3C propagation and baggage | Retained. | Phase 3 |
| Logs and basic metrics | Retained as separately gated signals after trace routing is production-ready. | Phase 8 |
| Lightweight enrichment/filtering | Retained as an OTel-native synchronous transform/filter extension or upstream processor optimization, with deterministic order and removal handles. | Phase 7 |
| SDK discovery and statistics | Retained through distribution info, instance lookup/list/count, immutable config snapshots, and per-instance operational statistics. | Public API; Phase 2 |
| CDN asynchronous loading | Retained if a CDN build is approved. Initialization uses callbacks/promises and never depends on a synchronous factory return before loading completes. | Phase 8 |
| Lazy initialization | Retained as a measured optimization for maps, providers, processors, and instrumentation bundles. | Performance and bundle size |
| Batching and timer coalescing | Retained, preferably through upstream processors/exporters. Timers run only while work is pending and are owned per instance. | Phase 5; Performance |
| Object pooling | Tracked as an evidence-gated optimization, not a baseline design. It requires demonstrated benefit without semantic or memory-retention regressions. | Performance |
| Performance monitoring hooks | Retained as optional benchmark/diagnostic hooks that do not require a vendor SDK and do not emit recursive telemetry. | Phase 1; Diagnostics |
| Frame-budget targets | Retained, including initialization, span creation, attributes, context propagation, and span completion. Routing overhead has additional budgets. | Performance |
| Coverage and cleanup enforcement | Retained. The test harness tracks created instances/resources and fails with owner details when cleanup is incomplete. | Testing |
| Dynamic configuration tests | Retained for every option declared runtime-mutable. | Phase 7; Testing |
| Browser compatibility matrix | Retained and made a release artifact backed by real-browser CI. | Browser and loader policy |
| Documentation and API examples | Retained for every public package, interface, lifecycle, extension point, and unsupported scenario. | Phase 1; GA criteria |
| Configurable diagnostics/error reporting | Retained with OTel-compatible diagnostics, stable codes, instance attribution, and explicit failure contracts. | Diagnostics |
| Privacy filtering | Retained as transforms/processors or instrumentation configuration before export, not as Application Insights envelope mutation. | Phase 7; Security and privacy |
| Performance and bundle regression tracking | Retained as blocking CI gates with per-package and preset baselines. | Phase 1; Performance and bundle size |

### 8.2 Conflicts addressed differently

| Previous rule or assumption | Conflict | Replacement approach |
|---|---|---|
| No global state | The upstream OTel API is intentionally global, and the PoC depends on one realm-wide provider. | Permit exactly one minimal global router/context registration. Keep all mutable pipeline, backend, and instance state behind its owned registry. Test conflicts and never overwrite another owner. |
| No `@opentelemetry/*` imports | This prevents genuine upstream interoperability and duplicates contracts. | Import supported public upstream packages directly, pin versions, run contract tests, and avoid internal paths or local forks. |
| Reimplement OTel-compatible `IOTel*` interfaces | Parallel interfaces drift from upstream and make instrumentation/exporter connection harder. | Expose upstream types. Add distribution interfaces only for routing, ownership, lifecycle, diagnostics, and loader behavior not supplied upstream. |
| Factory and closure implementations only | Upstream SDK components are class-based, and wrapping them solely to enforce a style adds code and size. | Use factories for distribution composition where useful; otherwise follow upstream idioms and select classes, closures, or plain objects based on API fit and measured output. |
| Return interface types only; never expose concrete OTel classes | Advanced consumers need standard provider/processor/exporter types and upstream extension points. | Keep distribution internals encapsulated while exposing the minimum standard upstream objects required for composition and interoperability. |
| `I`, `IOTel`, `_I`, `e` naming and `createEnumStyle` | These conventions belong to the prior codebase and would duplicate or rename upstream APIs. | Follow repository TypeScript conventions and upstream names. Distribution-owned public names must be clear, documented, and API-reviewed. |
| Never copy config; use Application Insights `onConfigChange` and `IUnloadHook` | Those utilities are not part of a vendor-neutral OTel distribution, and blindly retaining caller-owned mutable objects makes atomic updates difficult. | Validate and normalize startup configuration into instance-owned immutable state. Runtime changes use a typed update transaction with rollback and a removable subscription/ownership contract. |
| Required custom `IOTelErrorHandlers` and `handleErrors.ts` | This creates a dependency on the prior SDK's diagnostics system. | Use injected diagnostics plus upstream `diag` compatibility, stable distribution error codes, typed errors/results, and no silent console fallback in library code. |
| No singleton or global provider under any circumstances | Standard instrumentations discover providers through the global OTel API. | One distribution-owned router is the supported singleton per realm; individual providers, pipelines, and instances remain isolated and non-global. |
| Main SDK provides `getTracer`, `getLogger`, and `getMeter` wrappers | Proprietary getters obscure the normal OTel API and require signals before routing is proven. | Applications use upstream APIs; the distribution controls instance selection and provider routing. Logs and metrics receive independent routing designs before inclusion. |
| Telemetry initializers mutate Application Insights envelopes | Core is vendor-neutral and should not know backend envelopes. | Define ordered OTel-native transform/filter hooks over signal data. Backend envelope mutation, if unavoidable, belongs to that exporter integration. |
| Application Insights configuration and tracking API migration | Application Insights is no longer the product. | Maintain no legacy mapping in core. Any demanded compatibility is separately designed, packaged, versioned, and tested as an optional bridge. |
| Azure Monitor connection string and exporter as a required dependency | A required backend would violate vendor neutrality. | Use OTLP as the reference path and standard exporter contracts. Azure Monitor is one optional exporter integration. |
| Application Insights dynamic config utility and config mutation model | It couples lifecycle and data structures to the old SDK. | Use distribution-owned update transactions with an explicit list of mutable fields; replacement of immutable pipeline dependencies requires restart or provider swap. |
| Hard-code prior ESLint formatting rules, including four-space indentation and `I` interface prefixes | Formatting and naming are repository policy, not product architecture, and conflict with upstream examples/types. | Adopt one repository formatter/linter configuration in Phase 1 and enforce it consistently without renaming upstream concepts. |
| Build log and metric implementations locally | Upstream SDKs already define these components and their maturity differs by signal. | Route and compose upstream signal providers only after signal-specific feasibility, browser cost, and interoperability reviews. |
| Build samplers, processors, propagators, resources, baggage, and ID generators | Reimplementation increases size and compatibility risk. | Compose and test upstream implementations; add only missing browser-routing adapters. |
| ES5 syntax inside the full SDK | It increases code and constrains optimization despite the modern-runtime target. | Keep the full SDK modern. If required, ship a tiny separate ES5-compatible loader/no-op package with no production pipeline logic. |

### 8.3 Traceability rule

Every implementation issue must link to at least one retained requirement or
conflict replacement above. A requirement may be removed only through an
approved architecture decision that updates this table, the affected exit
criteria, and the compatibility/support documentation.

## 9. Delivery Plan

### Phase 0 - Preserve and graduate the PoC

1. Restore the existing PoC history or port it into the new package layout
   without changing its proven scenario.
2. Convert its conclusions and gaps into executable acceptance tests.
3. Pin an initial compatible OpenTelemetry JS release family.
4. Record architecture decisions for:
   - one global routing provider;
   - tracer binding at acquisition;
   - missing instance behavior;
   - global ownership conflicts;
   - browser context limitations.
5. Replace the PoC's custom in-memory span implementation with delegation to two
   real upstream SDK tracer providers and in-memory exporters.
6. Keep the overlapping Alpha/Beta browser test with identical instrumentation
   scopes and explicit async parent contexts.

**Exit criteria:** The original PoC still passes using real isolated upstream SDK
pipelines, and its architecture decisions are recorded.

### Phase 1 - Repository and quality foundation

1. Establish the workspace and package boundaries.
2. Configure TypeScript, ESM exports, API reports, linting, formatting, unit
   tests, real-browser tests, and bundle-size checks.
3. Add deterministic test exporters and fake-clock/browser fixtures.
4. Add an upstream OTel version compatibility policy and dependency update gate.
5. Add release, security, privacy, and API review gates.

**Exit criteria:** Packages build reproducibly and CI enforces API,
interoperability, browser, lifecycle, and bundle checks.

### Phase 2 - Production routing and instance lifecycle

1. Implement the bridge state machine and instance registry.
2. Implement routing-provider delegation and instance-bound tracer caching.
3. Implement transactional instance startup with reverse-order rollback.
4. Implement per-instance `forceFlush()` and idempotent `shutdown()`.
5. Define stale tracer behavior and prevent telemetry after shutdown.
6. Implement global conflict diagnostics without overwriting another SDK.
7. Implement coordinated distribution shutdown.
8. Stress test create/start/use/flush/shutdown loops for leaked state.

**Exit criteria:** Two real instances run simultaneously, export only their own
spans, and shut down independently without leaked hooks, timers, or pipeline
state.

### Phase 3 - Context and propagation

1. Integrate the selected upstream browser context manager.
2. Support deterministic explicit context across asynchronous boundaries.
3. Add W3C Trace Context and Baggage injection/extraction.
4. Add configurable cross-origin propagation allow lists.
5. Test nested instance boundaries and active span contexts.
6. Test callbacks, promises, timers, DOM events, and unsupported async cases.
7. Publish an exact context support matrix.

**Exit criteria:** Supported context paths preserve instance, trace, and parent
identity; unsupported paths are documented and do not cross pipelines.

### Phase 4 - Upstream instrumentation interoperability

1. Build the instrumentation initialization/binding helper.
2. Graduate document-load coverage from the PoC.
3. Spike fetch and XHR shared-patch ownership models.
4. Select and document safe ownership semantics per instrumentation category.
5. Add history/navigation instrumentation after router behavior is tested.
6. Verify user-supplied and third-party upstream instrumentations.
7. Implement reverse-order disablement during rollback and shutdown.
8. Detect duplicate patch attempts and incompatible ownership at startup.

**Exit criteria:** The supported instrumentation matrix produces correctly
routed and parented spans in overlapping instances and unloads cleanly.

### Phase 5 - Exporter and processor interoperability

1. Validate simple and batch span processors per instance.
2. Validate OTLP/HTTP export through an OpenTelemetry Collector.
3. Test custom processors, exporters, samplers, resources, and ID generators.
4. Define processor/exporter error and timeout propagation.
5. Test bounded queues, page hide, unload, offline transitions, and failed
   exports using upstream behavior.
6. Document extension contracts and version requirements.

**Exit criteria:** Standard upstream/custom pipeline components attach without
distribution-specific wrappers unless a documented browser bridge is required.

### Phase 6 - Hostile coexistence and realm boundaries

1. Test another provider registered before the distribution.
2. Test duplicate `@opentelemetry/api` package copies.
3. Test module federation and independently bundled consumers.
4. Test iframes and workers as separate realms.
5. Test multiple copies and versions of this distribution.
6. Define detection, supported coexistence, and explicit failure behavior.

**Exit criteria:** Every tested topology either works predictably or fails with
an actionable diagnostic; none silently mixes pipelines.

### Phase 7 - Dynamic management and optional bridges

1. Add instrumentation load/unload only after ownership semantics are stable.
2. Add dynamic configuration only for options with atomic update and rollback
   behavior.
3. Define a narrow bridge interface for integrations that cannot consume
   standard OTel contracts directly.
4. Validate optional backend exporters in separate packages.
5. Evaluate legacy API bridges independently; do not add them to core.

**Exit criteria:** Optional capabilities preserve core vendor neutrality,
instance isolation, lifecycle guarantees, and tree shaking.

### Phase 8 - Logs, metrics, loader, and distribution

1. Run separate architecture and browser feasibility reviews for logs and
   metrics.
2. Extend routing only where upstream signal APIs require it.
3. Finalize npm exports, source maps, API documentation, examples, and support
   policy.
4. Decide and document the browser target, CDN loader/snippet, ES2015 loader,
   pre-ES2015 skip/no-op behavior, and callback/promise initialization contract.
5. If approved, build the loader and no-op as separate size-budgeted packages;
   never place fallback logic in the full SDK.
6. Run preview adoption with multiple frameworks, bundlers, instrumentations,
   collectors, and exporters.
7. Complete threat model, privacy review, performance sign-off, and API review.

## 10. Cross-Cutting Requirements

### Upstream compatibility

- Inspect current upstream contracts before every implementation phase.
- Pin supported versions and test the full declared range.
- Avoid imports from upstream internal paths.
- Prefer contributing required fixes upstream over maintaining local forks.
- Any upstream divergence needs an ADR, tests, benchmark, and maintenance owner.

### Lifecycle

- Startup is transactional and rolls back partial work.
- Every resource is owned by either the distribution or one instance.
- Instance shutdown does not affect unrelated instances.
- Distribution shutdown disables owned instrumentations before providers.
- `forceFlush()` and `shutdown()` have explicit timeout and error contracts.
- No spans are accepted after the owning instance reaches shutdown.

### Correctness

- Instance selection cannot be inferred from mutable process-global variables.
- A tracer never changes its owning instance.
- Instrumentation scope name/version/schema URL remain intact.
- Parent trace identity, trace flags, trace state, links, events, attributes, and
  status pass through routing without semantic changes.
- No error path silently reroutes telemetry to another instance.

### Configuration

- Validate all required dependencies before registering globals, patching browser
  APIs, starting timers, or creating exporters.
- Treat caller configuration as input, not shared mutable state. Normalize it
  into an instance-owned immutable snapshot.
- Inject resources, samplers, processors, exporters, propagators, context
  policy, diagnostics, clocks, and platform capabilities.
- Publish defaults and distinguish omitted values from invalid values.
- Define the mutable field set explicitly; all other changes require instance
  replacement or a documented provider restart.
- Apply runtime updates atomically: validate, prepare, commit, then dispose
  replaced resources. Roll back on failure.
- Return a removal/disposal handle for every configuration subscription and
  release it during instance shutdown.
- Never expose mutable processor, exporter, instrumentation, or resource arrays
  through configuration snapshots.
- Test concurrent update, update-during-flush, update-during-shutdown, failed
  update rollback, and subscription cleanup.

### Performance

The browser frame-budget guideline remains 5 ms. Initial p95 targets, subject to
Phase 0 baselines:

| Measure | Target |
|---|---|
| Routing overhead on `getTracer()` p95 | Under 0.05 ms beyond upstream provider cost |
| Bound-tracer span start overhead p95 | Under 0.02 ms beyond upstream tracer cost |
| Distribution initialization p95 | Under 5 ms excluding instrumentation patching and network |
| End-to-end span creation p95 | Under 0.1 ms |
| Attribute addition p95 | Under 0.05 ms |
| Context propagation p95 | Under 0.1 ms |
| Span completion/processor handoff p95 | Under 0.2 ms |
| Idle work | No continuous distribution-owned timers |
| Bundle size | Separate budgets for router, distribution core, and instrumentation presets |

- Establish gzip and Brotli byte baselines in Phase 0 for the router alone,
  minimum manual-tracing distribution, default tracing preset, each
  instrumentation preset, loader, and no-op package.
- Set blocking absolute budgets and permitted percentage growth in Phase 1
  before feature implementation. Every release reports raw, gzip, and Brotli
  sizes and identifies dependency contributors.
- Test tree shaking with representative Vite, webpack, Rollup, and esbuild
  applications. Importing the router must not pull instrumentations, exporters,
  logs, metrics, loaders, or backend bridges into the bundle.
- Mark package side effects precisely; do not rely on import-time global
  registration.
- Keep instrumentation and exporter presets opt-in and independently importable.
- Start timers only for pending work, coalesce timers per owner when possible,
  and stop them immediately when queues empty or shutdown begins. Continuous
  interval timers are prohibited.
- Use lazy maps, provider creation, and caches only where measurements justify
  them.
- Prefer upstream batching. Any custom queue must be bounded and benchmarked.
- Treat object pooling as an experiment requiring allocation-profile evidence,
  semantic conformance tests, memory-retention tests, and a measurable win.
- Optional performance hooks use injected clocks/observers, remain disabled by
  default, and cannot emit recursive telemetry.

### Packaging and bundle size

- Publish ESM-first packages with explicit exports, type declarations, source
  maps, license data, and side-effect metadata.
- Keep router, distribution core, instrumentation presets, testing utilities,
  loader/no-op, and backend integrations in separate entry points or packages.
- Do not duplicate upstream API or SDK implementations to avoid version and byte
  cost.
- Run dependency duplication checks, especially for `@opentelemetry/api`.
- Reject dependencies that introduce unowned globals, unnecessary Node
  polyfills, unsafe dynamic evaluation, or disproportionate browser cost.
- Track minimum and preset bundles independently; a large optional integration
  must not consume the core budget.
- Generate a machine-readable size report and compare it against the base branch
  in CI.

### Browser and loader policy

The previous browser targets remain provisional requirements until Phase 8
validates current customer and platform data:

| Runtime | Planned treatment |
|---|---|
| ES2020+ supported browsers | Full distribution |
| ES2015 to pre-ES2020 browsers | Small capability-detecting loader only, if required |
| Pre-ES2015 browsers | Skip the full download or load a separate ES5-compatible no-op package, if required |

- Publish an exact Chrome, Edge, Firefox, and Safari version matrix for every
  release.
- Capability detection happens before downloading the full distribution.
- The full distribution contains no legacy no-op branches.
- A no-op package, if shipped, is API-compatible only with the distribution
  lifecycle surface and makes its disabled state observable.
- CDN initialization is asynchronous and uses callbacks or promises for success
  and failure. Consumers must not rely on a synchronous return while a script is
  loading.
- Loader, no-op, npm, and CDN paths receive separate integration, CSP, integrity,
  caching, and failure tests.

### Security and privacy

- Core routing must not inspect or transform telemetry payloads.
- Instrumentation presets document every automatically collected field.
- Cross-origin propagation is opt-in through explicit allow lists.
- Never collect request/response bodies, credentials, or auth headers by default.
- Bound attributes, events, links, queues, retries, and payloads through upstream
  or integration configuration.
- Threat-model global registration, monkey patching, prototype interaction,
  supply-chain dependencies, and untrusted instance identifiers.
- Diagnostics never include secrets or raw telemetry payloads.

### Diagnostics

- Define stable codes for global conflicts, routing, lifecycle,
  instrumentation ownership, context limitations, and extension failures.
- Support an injected diagnostic sink and interoperability with upstream `diag`;
  do not require an Application Insights diagnostics implementation.
- Diagnostics must identify the responsible instance when safe.
- Diagnostic output must not recursively emit telemetry.
- Library code does not silently fall back to `console`; any development console
  sink is explicitly configured.
- Unsupported combinations fail early rather than degrading into cross-routing.

### Testing

- Track all distributions, instances, global registrations, instrumentations,
  patches, listeners, timers, config subscriptions, processors, exporters, and
  queues created by a test.
- Fail the test automatically when any tracked resource remains owned after
  cleanup, and report its type, owner instance, and allocation site when
  available.
- Collect and publish code coverage for every production package.
- Unit tests for routing, state transitions, rollback, caching, and conflicts.
- Contract tests against supported upstream OTel versions.
- Real-browser tests for supported Chrome, Edge, Firefox, and Safari versions.
- Alpha/Beta overlapping-operation tests derived from the PoC.
- Multi-instance tests using identical instrumentation scope names.
- Shared-patch tests for fetch, XHR, history, timers, and DOM events.
- Repeated startup/shutdown and fake-timer leak tests.
- Duplicate-package, module-federation, iframe, and worker tests.
- OTLP collector integration tests.
- Performance and bundle-size regression gates.
- Dynamic configuration success, rollback, concurrency, and cleanup tests for
  every runtime-mutable field.
- Failure tests for invalid configuration, prior global registration, exporter
  rejection, partial startup, unload during export, and stale tracer use.

### Documentation and API governance

- Generate API reports and complete TypeDoc for every public distribution-owned
  type, method, option, lifecycle transition, error, and example.
- Publish package/version compatibility, browser support, instrumentation
  ownership, context support, topology, and optional integration matrices.
- Include npm, bundler, collector, multi-instance, explicit async-context, flush,
  shutdown, and CDN examples where applicable.
- Public API changes require review; experimental APIs are labeled and isolated
  from stable entry points.
- Document unsupported behavior directly rather than relying on no-op fallbacks.

## 11. General Availability Criteria

- Applications use the standard upstream OTel API for manual telemetry.
- Supported upstream instrumentations connect through documented configuration.
- At least two overlapping instances remain isolated with identical scope names.
- Supported automatic instrumentation does not double patch or cross pipelines.
- W3C context and baggage work across documented browser/network paths.
- Standard processors and exporters attach without proprietary replacements.
- Startup rollback, per-instance shutdown, and distribution shutdown pass leak
  and race stress tests.
- Conflicting globals and unsupported topologies produce actionable diagnostics.
- API, browser, compatibility, OTLP integration, performance, bundle, privacy,
  and security gates pass.
- Absolute and regression bundle budgets are approved and passing for every
  published entry point.
- Cleanup enforcement reports no orphaned resources across repeated real-browser
  test runs.
- Browser, context, instrumentation, topology, and extension compatibility
  matrices are published.
- Core packages contain no Application Insights-specific API or schema.

## 12. Open Decisions

| Decision | Required by |
|---|---|
| Exact upstream OTel package/version range | Phase 0 |
| Missing instance behavior during `getTracer()` | Phase 0 |
| Stale bound-tracer behavior after shutdown | Phase 2 |
| Whether one optional default instance is allowed | Phase 2 |
| Browser context manager and supported async matrix | Phase 3 |
| Fetch/XHR shared-patch ownership model | Phase 4 |
| Scope and behavior of dynamic configuration | Phase 7 |
| Logs and metrics inclusion | Phase 8 |
| CDN loader and legacy-browser policy | Before GA |
| Absolute gzip/Brotli budgets for each package and preset | Phase 1 |
| Allowed per-change and per-release bundle growth | Phase 1 |
| Lightweight transform/filter contract | Phase 7 |
| Runtime statistics fields and stability guarantees | Phase 2 |
| Final package names and organizational scope | Before preview |

## 13. AI-Assisted Execution

Use AI aggressively for bounded implementation and validation while keeping
product decisions reviewable:

1. Turn phase items into small vertical issues with acceptance tests, upstream
   references, package boundaries, and cleanup requirements.
2. Ask AI to inspect the pinned upstream source and type declarations before
   proposing code; never rely on remembered OTel signatures.
3. Generate lifecycle, conflict, concurrency, and failure tests with production
   code.
4. Use AI to compare public API reports, dependency upgrades, browser failures,
   bundle diffs, performance results, and compatibility matrices.
5. Use independent AI review for global state, cross-instance leakage, patch
   ownership, shutdown races, and security-sensitive changes.
6. Record architectural decisions so later agents receive stable constraints.
7. Prefer executable browser slices over broad scaffolding or speculative
   abstractions.
8. Require human approval for public APIs, support claims, privacy behavior,
   browser patching, dependency policy, and releases.

AI-generated work must meet the same interoperability, lifecycle, correctness,
performance, security, documentation, and test gates as human-written work.

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";
import { visualizer } from "rollup-plugin-visualizer";

const esmOutput = {
  format: "es",
  sourcemap: true,
};

const externalOpenTelemetry = (id) => id.startsWith("@opentelemetry/");
const compile = () => typescript({ tsconfig: "./tsconfig.src.json" });
const bundleForBrowser = () => [nodeResolve({ browser: true }), commonjs(), compile()];

export default [
  {
    input: "src/index.ts",
    // Share APIs with npm consumers and let their bundler select the SDK platform.
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      ...esmOutput,
      file: "dist/esm/index.js",
    },
  },
  {
    // A separate entry point, so an application that never configures instrumentations does not
    // pay for them. Its on-demand imports stay external here, leaving the consumer's bundler to
    // split out the instrumentations they enable.
    input: "src/instrumentation/browserInstrumentation/index.ts",
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      ...esmOutput,
      file: "dist/esm/instrumentations.js",
    },
  },
  {
    input: "src/index.ts",
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      file: "dist/commonjs/index.cjs",
      format: "cjs",
      exports: "named",
      sourcemap: true,
    },
  },
  {
    input: "src/instrumentation/browserInstrumentation/index.ts",
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      file: "dist/commonjs/instrumentations.cjs",
      format: "cjs",
      exports: "named",
      sourcemap: true,
    },
  },
  {
    input: "src/index.ts",
    // Retain the application's API singletons, including pre-initialization handles.
    external: ["@opentelemetry/api", "@opentelemetry/api-logs"],
    plugins: bundleForBrowser(),
    output: {
      ...esmOutput,
      file: "dist/esm/index.min.js",
      plugins: [
        terser(),
        visualizer({
          filename: "reports/bundle-stats.html",
          title: "OpenTelemetry browser ESM bundle",
          template: "treemap",
          sourcemap: true,
          gzipSize: true,
          brotliSize: true,
        }),
      ],
    },
  },
  {
    input: "src/browser.ts",
    plugins: bundleForBrowser(),
    output: [
      {
        file: "dist/browser/opentelemetry-browser.umd.js",
        format: "umd",
        name: "Microsoft.OpenTelemetry",
        sourcemap: true,
      },
      {
        file: "dist/browser/opentelemetry-browser.umd.min.js",
        format: "umd",
        name: "Microsoft.OpenTelemetry",
        sourcemap: true,
        plugins: [terser()],
      },
      {
        file: "dist/browser/opentelemetry-browser.iife.js",
        format: "iife",
        name: "Microsoft.OpenTelemetry",
        sourcemap: true,
      },
      {
        file: "dist/browser/opentelemetry-browser.iife.min.js",
        format: "iife",
        name: "Microsoft.OpenTelemetry",
        sourcemap: true,
        plugins: [terser()],
      },
    ],
  },
  {
    input: "src/instrumentation/browserInstrumentation/index.ts",
    plugins: bundleForBrowser(),
    output: [
      {
        file: "dist/browser/opentelemetry-browser-instrumentations.umd.js",
        format: "umd",
        name: "Microsoft.OpenTelemetryInstrumentations",
        inlineDynamicImports: true,
        sourcemap: true,
      },
      {
        file: "dist/browser/opentelemetry-browser-instrumentations.umd.min.js",
        format: "umd",
        name: "Microsoft.OpenTelemetryInstrumentations",
        inlineDynamicImports: true,
        sourcemap: true,
        plugins: [terser()],
      },
      {
        file: "dist/browser/opentelemetry-browser-instrumentations.iife.js",
        format: "iife",
        name: "Microsoft.OpenTelemetryInstrumentations",
        inlineDynamicImports: true,
        sourcemap: true,
      },
      {
        file: "dist/browser/opentelemetry-browser-instrumentations.iife.min.js",
        format: "iife",
        name: "Microsoft.OpenTelemetryInstrumentations",
        inlineDynamicImports: true,
        sourcemap: true,
        plugins: [terser()],
      },
    ],
  },
  {
    input: "src/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: {
      file: "dist/esm/index.d.ts",
      format: "es",
    },
  },
  {
    input: "src/instrumentation/browserInstrumentation/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: {
      file: "dist/esm/instrumentations.d.ts",
      format: "es",
    },
  },
  {
    input: "src/snippet.ts",
    plugins: [typescript({ tsconfig: "./tsconfig.src.json" })],
    output: {
      ...esmOutput,
      file: "dist/esm/snippet.js",
    },
  },
  {
    input: "src/snippet.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: {
      file: "dist/esm/snippet.d.ts",
      format: "es",
    },
  },
];

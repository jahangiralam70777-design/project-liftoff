// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Allow CI/hosting to override the nitro deploy preset (e.g. Render → "node-server").
// Falls back to the Lovable default (cloudflare-module) for sandbox/preview builds.
const nitroPreset = process.env.NITRO_PRESET;

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    build: {
      // Keep build memory low on CI (Render): no sourcemaps to hold in memory,
      // and skip the gzip-size report pass (it re-reads every chunk into RAM).
      sourcemap: false,
      reportCompressedSize: false,
    },
    // Strip console.log/console.debug in production bundles; keep warn/error
    // so structured logging still flows to the sandbox/server logs.
    esbuild: {
      drop: process.env.NODE_ENV === "production" ? ["debugger"] : [],
      pure: process.env.NODE_ENV === "production" ? ["console.log", "console.debug"] : [],
    },
  },
  ...(nitroPreset
    ? {
        nitro: {
          preset: nitroPreset,
          output: { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" },
        },
      }
    : {}),
});

// Bundles the Netlify background function (netlify/draft-job-background.ts) into apps/web/netlify/functions/ (inside the app, so the nested node_modules that hold its OpenTelemetry versions are on the resolution path).
// The app code uses the `@/` alias and the `spec` workspace package (TypeScript sources), neither of which Netlify's own function
// bundler resolves, so both are inlined here; real npm packages (pg, zod, OpenTelemetry, ...) stay external for Netlify to ship.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const outfile = path.join(web, "netlify/functions/draft-job-background.mjs");

await build({
  entryPoints: [path.join(web, "netlify/draft-job-background.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  alias: { "@": path.join(web, "src"), spec: path.resolve(web, "../../packages/spec") },
  logLevel: "info",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log(`built ${path.relative(process.cwd(), outfile)}`);

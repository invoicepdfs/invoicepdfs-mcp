/**
 * Put openapi.json next to the package, for `npm pack` and `npm publish`.
 *
 * The published package carries its own copy of the spec, because the tool
 * surface is built from it at startup and an installed package has no monorepo
 * around it. Where that copy comes from depends on which repo we are in:
 *
 *   invoicepdfs/            the monorepo: ../openapi.json is the real spec,
 *     openapi.json          kept current by .github/workflows/openapi.yml.
 *     mcp/                  Copy it. The copy is gitignored, because a copy
 *                           left lying around during development shadows the
 *                           repo's spec (see specPath in src/operations.ts)
 *                           and freezes the tool surface at whenever it was
 *                           made.
 *
 *   invoicepdfs-mcp/        the published mirror: openapi.json IS the spec,
 *     openapi.json          pushed here by the monorepo's mirror workflow.
 *     src/                  There is nothing above to copy from, so check the
 *                           one we have and leave it alone.
 *
 * Either way this must fail loudly rather than let `npm publish` ship a
 * package whose spec is missing, truncated, or half-written — the failure
 * would surface as a server that starts and advertises no tools, in a release
 * that is already public.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendored = join(packageRoot, "openapi.json");
const upstream = join(packageRoot, "..", "openapi.json");

// `postpack --clean`: drop the copy once the tarball holds it. Only in the
// monorepo, where the copy is a build artifact and leaving it behind is the
// documented trap -- it wins over the repo's spec (specPath in
// src/operations.ts) and freezes the tool surface at whenever it was made. In
// the mirror that same file IS the spec, so touching it would be the bug.
if (process.argv.includes("--clean")) {
  if (!existsSync(upstream)) {
    console.log("vendor-spec: nothing to clean — this copy is the spec.");
    process.exit(0);
  }
  rmSync(vendored, { force: true });
  console.log(`vendor-spec: removed ${vendored}`);
  process.exit(0);
}

if (existsSync(upstream)) {
  copyFileSync(upstream, vendored);
  console.log(`vendor-spec: copied ${upstream}`);
} else if (existsSync(vendored)) {
  console.log(`vendor-spec: using the committed ${vendored}`);
} else {
  throw new Error(
    `vendor-spec: no spec to publish. Looked for ${upstream} (monorepo) and ` +
      `${vendored} (mirror). The mirror gets its copy from the monorepo's ` +
      `mirror-mcp workflow.`,
  );
}

// Parsed rather than merely present: a spec that exists and does not load is
// the failure this guards, and it costs 10ms once at publish time.
const spec = JSON.parse(readFileSync(vendored, "utf8"));
const paths = Object.keys(spec.paths ?? {}).length;
if (paths === 0) {
  throw new Error(`vendor-spec: ${vendored} declares no paths.`);
}
console.log(`vendor-spec: ${paths} paths`);

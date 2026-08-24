#!/usr/bin/env node
// link-pi-types.mjs — resolves `@earendil-works/pi-coding-agent`'s type
// declarations for `tsc --noEmit` WITHOUT adding it as a real npm/bun
// dependency that has to be fetched over the network.
//
// Why: `index.ts` imports `VERSION`, `ExtensionAPI`, and
// `ExtensionCommandContext` as types from `@earendil-works/pi-coding-agent`.
// Typechecking `index.ts` for real (rather than excluding it, or papering
// over the missing module with an ambient `declare module` `any` shim that
// would defeat the point of checking it at all) requires that module's
// `.d.ts` files to be resolvable. The package itself is the full pi CLI
// build; this repo only needs its type declarations.
//
// Strategy: symlink node_modules/@earendil-works/pi-coding-agent to
// whatever copy is already installed globally (via `npm root -g`) — the
// same build that actually loads this extension at runtime, so the types
// checked here can never drift from the runtime API surface, and no
// network install is required. (Same approach as
// ../../cmux-session-fast/tools/link-pi-types.mjs.)
//
// Best-effort: if no global install is found, this warns and exits 0 so
// `bun install`/`bun test` still succeed. `bun run typecheck` will then fail
// with a clear "Cannot find module '@earendil-works/pi-coding-agent'"
// pointing back at this comment instead of failing silently or needing an
// `any` shim.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_SCOPE = "@earendil-works";
const PACKAGE_NAME = "pi-coding-agent";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LINK_DIR = join(REPO_ROOT, "node_modules", PACKAGE_SCOPE);
const LINK_PATH = join(LINK_DIR, PACKAGE_NAME);

function globalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch (error) {
    console.warn(`[link-pi-types] could not run \`npm root -g\`: ${error.message}`);
    return null;
  }
}

function isUsableTarget(target) {
  return existsSync(join(target, "package.json")) && existsSync(join(target, "dist", "index.d.ts"));
}

function alreadyLinkedTo(target) {
  try {
    return lstatSync(LINK_PATH).isSymbolicLink() && readlinkSync(LINK_PATH) === target;
  } catch (_) {
    return false;
  }
}

function lstatSyncSafe(p) {
  try {
    lstatSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  const root = globalRoot();
  if (!root) {
    console.warn(
      "[link-pi-types] skipping type link: `npm root -g` failed. " +
        "`bun run typecheck` will not be able to resolve @earendil-works/pi-coding-agent types.",
    );
    return;
  }

  const target = join(root, PACKAGE_SCOPE, PACKAGE_NAME);
  if (!isUsableTarget(target)) {
    console.warn(
      `[link-pi-types] no global install found at ${target}. ` +
        "Install pi globally (the same build that loads this extension) so " +
        "`bun run typecheck` can resolve @earendil-works/pi-coding-agent types. " +
        "`bun test` is unaffected (type-only imports are erased at runtime).",
    );
    return;
  }

  if (alreadyLinkedTo(target)) {
    return; // idempotent: nothing to do.
  }

  mkdirSync(LINK_DIR, { recursive: true });
  if (existsSync(LINK_PATH) || lstatSyncSafe(LINK_PATH)) {
    rmSync(LINK_PATH, { recursive: true, force: true });
  }
  symlinkSync(target, LINK_PATH, "dir");
  console.log(`[link-pi-types] linked node_modules/${PACKAGE_SCOPE}/${PACKAGE_NAME} -> ${target}`);
}

main();

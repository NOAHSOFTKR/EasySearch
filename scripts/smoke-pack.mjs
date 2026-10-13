#!/usr/bin/env node
/**
 * Installs the packed tarball into throwaway projects and checks that it works
 * as published: ESM and CommonJS, with and without the optional `layercache`
 * peer dependency, TypeScript consumers, and an esbuild bundle.
 *
 * Usage: npm run build && node scripts/smoke-pack.mjs
 * Requires network access to install `layercache` from the npm registry.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "easysearch-smoke-"));
const bin = (name) => join(root, "node_modules", ".bin", name);

// When started from an npm lifecycle script (e.g. `npm publish --dry-run`), npm passes its
// configuration down; a dry-run flag would stop the nested `npm pack` from writing a tarball.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_dry_run$/i.test(name)));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  try {
    const output = fn();
    console.log("ok");
    return output;
  } catch (error) {
    console.log("FAILED");
    console.error(error.stdout ?? "", error.stderr ?? "", error.message);
    process.exitCode = 1;
    throw error;
  }
}

function project(name, files) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", private: true }));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

const data = `[{ id: 1, title: "안녕하세요" }, { id: 2, title: "니아 TTS 봇" }, { id: 3, title: "검색 라이브러리" }]`;

const esmBasic = `
import { EasySearch, DataLoadError } from "@noahsoft/easy-search";
const es = new EasySearch({ data: async () => ${data}, keys: ["title"] });
const results = await es.search("니아");
if (results.length !== 1 || results[0].item.id !== 2) throw new Error("unexpected results " + JSON.stringify(results));
if (typeof DataLoadError !== "function") throw new Error("DataLoadError missing");
console.log("esm ok");
`;
const cjsBasic = `
const { EasySearch } = require("@noahsoft/easy-search");
const es = new EasySearch({ data: ${data}, keys: ["title"] });
es.search("검색").then((results) => {
  if (results.length !== 1 || results[0].item.id !== 3) throw new Error("unexpected results");
  console.log("cjs ok");
});
`;
const esmCache = (expectMissing) => `
import { EasySearch } from "@noahsoft/easy-search";
let calls = 0;
const es = new EasySearch({
  data: async () => { calls++; return ${data}; },
  keys: ["title"],
  advancedSettings: { useLayerCache: true },
});
try {
  await es.search("니아");
  await es.search("니아");
  if (${expectMissing}) throw new Error("expected a missing layercache error");
  if (calls !== 1) throw new Error("expected one load, got " + calls);
  await es.dispose();
  console.log("esm cache ok");
} catch (error) {
  if (!${expectMissing} || !/npm install layercache/.test(error.message)) throw error;
  console.log("esm missing-layercache error ok");
}
`;
const cjsCache = (expectMissing) => `
const { EasySearch } = require("@noahsoft/easy-search");
const es = new EasySearch({ data: async () => ${data}, keys: ["title"], advancedSettings: { useLayerCache: true } });
es.search("니아").then(
  async (results) => {
    if (${expectMissing}) throw new Error("expected a missing layercache error");
    if (results.length !== 1) throw new Error("unexpected results");
    await es.dispose();
    console.log("cjs cache ok");
  },
  (error) => {
    if (!${expectMissing} || !/npm install layercache/.test(error.message)) throw error;
    console.log("cjs missing-layercache error ok");
  },
);
`;
const typed = `
import { EasySearch, type SearchResult } from "@noahsoft/easy-search";
interface Post { id: number; title: string; author: { name: string } }
declare function getPosts(): Promise<Post[]>;
const es = new EasySearch({ data: () => getPosts(), keys: ["title", { name: "author.name", weight: 2 }] });
export const results: Promise<SearchResult<Post>[]> = es.search("니아", { mode: "fuzzy", limit: 20 });
// @ts-expect-error unknown key
new EasySearch({ data: () => getPosts(), keys: ["missing"] });
`;
const typedWithCache = `
import { CacheStack, MemoryLayer } from "layercache";
import { EasySearch } from "@noahsoft/easy-search";
const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })]);
export const es = new EasySearch({ data: [{ title: "니아" }], advancedSettings: { useLayerCache: true, cache } });
`;
const tsconfig = (module, moduleResolution, skipLibCheck) =>
  JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2022", lib: ["ES2022"], module, moduleResolution, skipLibCheck },
    include: ["*.ts", "*.mts", "*.cts"],
  });

try {
  const tarball = step("npm pack", () => {
    const out = run("npm", ["pack", "--json", "--pack-destination", work], root);
    return join(work, JSON.parse(out)[0].filename);
  });

  // 1. Without layercache.
  const bare = project("bare", {
    "esm.mjs": esmBasic,
    "cjs.cjs": cjsBasic,
    "esm-cache.mjs": esmCache(true),
    "cjs-cache.cjs": cjsCache(true),
    "typed.mts": typed,
    "tsconfig.json": tsconfig("NodeNext", "NodeNext", false),
  });
  step("install tarball without layercache", () => run("npm", ["install", "--no-audit", "--no-fund", tarball], bare));
  step("ESM import + search", () => run("node", ["esm.mjs"], bare));
  step("CommonJS require + search", () => run("node", ["cjs.cjs"], bare));
  step("ESM useLayerCache without layercache -> clear error", () => run("node", ["esm-cache.mjs"], bare));
  step("CJS useLayerCache without layercache -> clear error", () => run("node", ["cjs-cache.cjs"], bare));
  step("TypeScript (NodeNext, skipLibCheck: false) without layercache", () =>
    run("node", [join(root, "node_modules/typescript/bin/tsc"), "-p", "."], bare),
  );
  writeFileSync(join(bare, "tsconfig.json"), tsconfig("ESNext", "Bundler", false));
  step("TypeScript (Bundler resolution) without layercache", () =>
    run("node", [join(root, "node_modules/typescript/bin/tsc"), "-p", "."], bare),
  );
  step("esbuild bundle without layercache", () => {
    run(bin("esbuild"), ["esm.mjs", "--bundle", "--platform=node", "--format=esm", "--outfile=bundle.mjs", "--log-level=error"], bare);
    return run("node", ["bundle.mjs"], bare);
  });

  // 2. With layercache.
  const full = project("with-layercache", {
    "esm-cache.mjs": esmCache(false),
    "cjs-cache.cjs": cjsCache(false),
    "typed.mts": typedWithCache,
    "tsconfig.json": tsconfig("ESNext", "Bundler", true),
  });
  step("install tarball with layercache", () =>
    run("npm", ["install", "--no-audit", "--no-fund", tarball, "layercache@^5"], full),
  );
  step("ESM useLayerCache: true", () => run("node", ["esm-cache.mjs"], full));
  step("CommonJS useLayerCache: true", () => run("node", ["cjs-cache.cjs"], full));
  step("TypeScript: a CacheStack is accepted as advancedSettings.cache", () =>
    run("node", [join(root, "node_modules/typescript/bin/tsc"), "-p", "."], full),
  );
  step("esbuild bundle with layercache", () => {
    run(
      bin("esbuild"),
      ["esm-cache.mjs", "--bundle", "--platform=node", "--format=esm", "--outfile=bundle.mjs", "--log-level=error"],
      full,
    );
    return run("node", ["bundle.mjs"], full);
  });
  console.log("\nAll smoke checks passed.");
} finally {
  rmSync(work, { recursive: true, force: true });
}

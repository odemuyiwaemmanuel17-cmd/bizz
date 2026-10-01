/**
 * Test runner for the pure Phase-3 modules (contact.ts, feed.ts).
 * esbuild transpiles both the source modules and the TS test files into a
 * temp dir as ESM JavaScript, then node:test executes them.
 */
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = await mkdtemp(join(tmpdir(), "ph3-tests-"));
try {
  // 1) Compile the library modules under test.
  await build({
    entryPoints: ["src/lib/contact.ts", "src/lib/feed.ts"],
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });

  // 2) Transpile each test file with its relative imports rewritten to the
  //    compiled module paths, mark node builtins external, and run it.
  const rewrites = [
    {
      in: "../src/lib/contact",
      contact: true,
    },
    {
      in: "../src/lib/feed",
      feed: true,
    },
  ];
  void rewrites;
  const results = [];
  for (const testFile of ["tests/contact.test.ts", "tests/feed.test.ts"]) {
    const result = await build({
      entryPoints: [testFile],
      stdin: undefined,
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      external: ["node:test", "node:assert/strict"],
      plugins: [
        {
          name: "rewrite-lib-imports",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^\.\.\/src\/lib\// }, (args) => ({
              path: join(outDir, args.path.split("/").pop() + ".js"),
            }));
          },
        },
      ],
    });
    const outFile = join(outDir, testFile.split("/").pop().replace(/\.ts$/, ".mjs"));
    await writeFile(outFile, result.outputFiles[0].text);
    const run = spawnSync(process.execPath, ["--test", outFile], { encoding: "utf8" });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    results.push(run.status ?? 1);
  }
  process.exit(results.every((code) => code === 0) ? 0 : 1);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

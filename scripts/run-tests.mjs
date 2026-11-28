import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const outDir = path.resolve(".tmp-test");
fs.rmSync(outDir, { recursive: true, force: true });

const tsFiles = collectTsFiles(path.resolve("lib"));
const tscBin = path.resolve("node_modules/typescript/bin/tsc");

try {
  execFileSync(
    process.execPath,
    [
      tscBin,
      "--ignoreConfig",
      "--ignoreDeprecations",
      "6.0",
      "--rootDir",
      ".",
      ...tsFiles,
      "--outDir",
      outDir,
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "ES2022",
      "--esModuleInterop",
      "--skipLibCheck",
    ],
    { stdio: "inherit" }
  );

  execFileSync(process.execPath, ["--test", "tests/ragchat.test.mjs"], {
    stdio: "inherit",
  });
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

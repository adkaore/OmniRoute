import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = [
  ".next/cache",
  ".next/trace",
  ".next/trace-build",
  ".next/types",
  ".build/next/cache",
  ".build/next/trace",
  ".build/next/trace-build",
  ".build/next/types",
  "tests",
  "images",
];

for (const target of targets) {
  const fullPath = path.join(root, target);
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`[heroku-cleanup] removed ${target}`);
  }
}

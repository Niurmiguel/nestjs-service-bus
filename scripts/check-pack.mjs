// Fails when the npm package would ship files it must not (tests, CI, the
// emulator setup, configs) or miss the ones it needs, and when a source map
// points to a file that is not in the package.
//
// Run after the build: `npm run check:pack` builds, then runs this.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// --ignore-scripts: prepack would build again, and its output would mix with
// the JSON.
const [report] = JSON.parse(
  execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  })
);
const files = new Set(report.files.map((file) => file.path));

const forbidden = [
  /^test\//,
  /^\.github\//,
  /^scripts\//,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /(^|\/)Config\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.env/,
  /(^|\/)\.nvmrc$/,
  /\.tgz$/,
  /(^|\/)node_modules\//,
];
const required = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"];
if (existsSync(path.join(root, "CHANGELOG.md"))) {
  required.push("CHANGELOG.md");
}

const problems = [];
for (const file of files) {
  const rule = forbidden.find((pattern) => pattern.test(file));
  if (rule) problems.push(`must not be published: ${file} (${rule})`);
}
for (const file of required) {
  if (!files.has(file)) problems.push(`missing from the package: ${file}`);
}
// Source maps (.js.map, .d.ts.map) must point to sources that are published.
for (const file of files) {
  if (!file.endsWith(".map")) continue;
  const map = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  for (const source of map.sources ?? []) {
    const target = path.posix.join(path.posix.dirname(file), map.sourceRoot ?? "", source);
    if (!files.has(target)) problems.push(`${file} points to ${target}, which is not published`);
  }
}

if (problems.length > 0) {
  console.error(`npm pack would publish a broken package:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`npm pack: ${files.size} files, ${report.size} bytes packed; contents OK`);

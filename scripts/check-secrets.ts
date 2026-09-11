/**
 * Prüft, ob alle in ".dev.vars.example" gelisteten Variablen auch als
 * Cloudflare-Secrets für den Worker gesetzt sind (und meldet ungenutzte
 * Secrets, die dort fehlen). Ausführen mit: npm run check:secrets
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXAMPLE_PATH = join(__dirname, "..", ".dev.vars.example");

function expectedKeysFromExample(): string[] {
  const content = readFileSync(EXAMPLE_PATH, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=")[0].trim())
    .filter(Boolean);
}

function configuredSecretNames(): string[] {
  const output = execSync("npx wrangler secret list", { encoding: "utf8" });
  const secrets: { name: string }[] = JSON.parse(output);
  return secrets.map((s) => s.name);
}

const expected = expectedKeysFromExample();
const configured = configuredSecretNames();

const missing = expected.filter((key) => !configured.includes(key));
const extra = configured.filter((key) => !expected.includes(key));

for (const key of expected) {
  console.log(`${missing.includes(key) ? "FEHLT" : "OK   "} ${key}`);
}

if (extra.length > 0) {
  console.log(`\nAls Secret gesetzt, aber nicht in .dev.vars.example gelistet: ${extra.join(", ")}`);
}

if (missing.length > 0) {
  console.log(`\n${missing.length} Secret(s) fehlen: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\nAlle erwarteten Secrets sind gesetzt.");

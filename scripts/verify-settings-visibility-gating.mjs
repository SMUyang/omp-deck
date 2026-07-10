import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const context = await browser.newContext();
const page = await context.newPage();

const calls = { env: 0, bridges: 0, version: 0 };
page.on("request", (req) => {
	const url = req.url();
	if (url.includes("/api/settings/env")) calls.env++;
	else if (url.includes("/api/bridges") && req.method() === "GET") calls.bridges++;
	else if (url.includes("/api/version")) calls.version++;
});

console.log("→ Navigating to /settings");
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
console.log(`  loaded. url: ${page.url()}`);

const settingsChunkLoaded = await page.evaluate(async () => {
	const resp = await fetch(window.location.href, { method: "HEAD" });
	return resp.ok;
});
console.log(`  HEAD /settings: ${settingsChunkLoaded}`);

console.log("→ Switching to Messaging tab");
await page.click("text=Messaging");
await page.waitForTimeout(500);
console.log(`  url: ${page.url()}`);

calls.env = 0;
calls.bridges = 0;
console.log("→ Counting API calls for 5s while VISIBLE");
await page.waitForTimeout(5000);
const visibleEnv = calls.env;
const visibleBridges = calls.bridges;
console.log(`  /api/settings/env: ${visibleEnv}`);
console.log(`  /api/bridges:      ${visibleBridges}`);

console.log("→ Hiding page (emulating background tab)");
await page.evaluate(() => {
	Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
});

calls.env = 0;
calls.bridges = 0;
console.log("→ Counting API calls for 5s while HIDDEN");
await page.waitForTimeout(5000);
const hiddenEnv = calls.env;
const hiddenBridges = calls.bridges;
console.log(`  /api/settings/env: ${hiddenEnv}`);
console.log(`  /api/bridges:      ${hiddenBridges}`);

console.log("\n=== VERDICT ===");
const envReduced = hiddenEnv < visibleEnv;
const bridgesReduced = hiddenBridges < visibleBridges;
console.log(`Settings/env: visible=${visibleEnv}  hidden=${hiddenEnv}  ${envReduced ? "✅ reduced" : "❌ NOT reduced"}`);
console.log(`Bridges:     visible=${visibleBridges}  hidden=${hiddenBridges}  ${bridgesReduced ? "✅ reduced" : "❌ NOT reduced"}`);

await browser.close();
process.exit(envReduced && bridgesReduced ? 0 : 1);

import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// List all WS connections
const wsInfo = await page.evaluate(() => {
	const out = [];
	const orig = window.WebSocket;
	return new Promise((resolve) => {
		let count = 0;
		const wrapped = function(...args) {
			count++;
			const ws = new orig(...args);
			const stack = new Error().stack;
			out.push({ url: args[0], stack });
			ws.addEventListener("open", () => console.log(`[ws ${count}] open ${args[0]}`));
			ws.addEventListener("close", () => console.log(`[ws ${count}] close`));
			ws.addEventListener("error", (e) => console.log(`[ws ${count}] error`));
			ws.addEventListener("message", (e) => console.log(`[ws ${count}] msg ${e.data?.slice(0, 100)}`));
			return ws;
		};
		wrapped.prototype = orig.prototype;
		window.WebSocket = wrapped;
		setTimeout(() => resolve({ wsCount: count, log: out }), 2000);
	});
});
console.log("WS hooks:", wsInfo);

// Now snapshot the full body content
const bodyText = await page.evaluate(() => document.body.innerText);
console.log("\n=== FULL PAGE TEXT ===");
console.log(bodyText);

await page.screenshot({ path: "/tmp/omp-deck-full.png", fullPage: true });
console.log("\n→ full screenshot saved");

await browser.close();

import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());

page.on("websocket", (ws) => {
	console.log(`[ws] opened: ${ws.url()}`);
	ws.on("framesent", (e) => {
		console.log(`[ws] → ${e.payload.toString().slice(0, 200)}`);
	});
	ws.on("framereceived", (e) => {
		console.log(`[ws] ← ${e.payload.toString().slice(0, 200)}`);
	});
	ws.on("close", () => console.log(`[ws] closed`));
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

console.log("→ Click session");
await page.locator("text=重新搜索loop").first().click();
await page.waitForTimeout(3000);

const ta = page.locator("textarea").first();
console.log("→ Type + send");
await ta.click();
await ta.fill("hello test for undo");
await ta.press("Enter");
await page.waitForTimeout(5000);

await page.screenshot({ path: "/tmp/after-send.png", fullPage: true });
await browser.close();

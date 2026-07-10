import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());

page.on("websocket", (ws) => {
	ws.on("framesent", (e) => {
		const data = e.payload.toString();
		if (data.includes("prompt") || data.includes("cancel") || data.includes("subscribe")) {
			console.log(`[ws] → ${data.slice(0, 200)}`);
		}
	});
	ws.on("framereceived", (e) => {
		const data = e.payload.toString();
		// Filter for turn_end, agent_end, prompt_queued, queue_state
		if (data.match(/"type":"(turn_end|agent_end|prompt_queued|queue_state)"/)) {
			console.log(`[ws] ← ${data.slice(0, 200)}`);
		}
	});
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

console.log("→ Click 重新搜索loop");
await page.locator("text=重新搜索loop").first().click();
await page.waitForTimeout(3000);

console.log("→ Waiting for current turn to end (up to 120s)");
let turnEnded = false;
for (let i = 0; i < 120; i++) {
	const turnEndCount = await page.evaluate(() => {
		// Try to read stopReason or isStreaming from DOM
		const stopBtn = document.querySelector('button[aria-label*="Stop"]');
		return stopBtn ? 1 : 0;
	});
	if (turnEndCount === 0) {
		console.log(`  t=${i}s no stop button — likely idle`);
		turnEnded = true;
		break;
	}
	await page.waitForTimeout(1000);
}
if (!turnEnded) {
	console.log("  timed out waiting for turn to end");
}

const ta = page.locator("textarea").first();
const enabled = await ta.isEnabled();
console.log(`  textarea enabled: ${enabled}`);
if (!enabled) {
	console.log("  textarea not enabled, abort");
	await page.screenshot({ path: "/tmp/not-enabled.png", fullPage: true });
	await browser.close();
	process.exit(1);
}

console.log("→ Send first message");
await ta.click();
await ta.fill("first test message for queue check");
await ta.press("Enter");
await page.waitForTimeout(2000);

// Now quickly send second message
console.log("→ Send second message immediately (should queue)");
await ta.click();
await ta.fill("SECOND message that should be queued while first is processing");
await ta.press("Enter");

// Watch for queued bubble
console.log("→ Watching for queued bubble (max 10s)");
for (let i = 0; i < 20; i++) {
	const queuedCount = await page.locator('text=/· queued/').count();
	const cancelBtnCount = await page.locator('button[aria-label="Cancel queued prompt"]').count();
	const editBtnCount = await page.locator('button[aria-label="Edit queued prompt"]').count();
	const userBubbleCount = await page.locator('text=/SECOND message that should be queued/').count();
	console.log(`  t=${i * 500}ms  queued-label=${queuedCount}  user-bubble=${userBubbleCount}  cancel-btn=${cancelBtnCount}  edit-btn=${editBtnCount}`);
	if (queuedCount > 0) {
		console.log("  ✅ Found queued bubble!");
		await page.screenshot({ path: "/tmp/queued-with-undo.png", fullPage: true });
		if (cancelBtnCount > 0) {
			console.log("  → Clicking cancel button");
			await page.locator('button[aria-label="Cancel queued prompt"]').first().click();
			await page.waitForTimeout(2000);
			const after = await page.locator('button[aria-label="Cancel queued prompt"]').count();
			console.log(`  after cancel click: cancel-btn count = ${after} (should be 0)`);
		}
		break;
	}
	await page.waitForTimeout(500);
}

await page.screenshot({ path: "/tmp/queue-test-final.png", fullPage: true });
await browser.close();

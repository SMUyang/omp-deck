import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

// Click 重新搜索loop
await page.locator("text=重新搜索loop").first().click();
await page.waitForTimeout(2500);

const ta = page.locator("textarea").first();

// Send first message — ask for a long response
console.log("→ Sending first message (long response)");
await ta.click();
await ta.fill("please write a very long detailed response about the history of computing, at least 500 words");
await ta.press("Enter");

// Wait for agent to start streaming
console.log("→ Waiting for streaming to start");
for (let i = 0; i < 10; i++) {
	const streaming = await page.locator('text=/streaming/i').count();
	const stopBtn = await page.locator('button[aria-label*="Stop"], button[title*="Stop"], button[title*="stop"]').count();
	console.log(`  t=${i * 500}ms  streaming-indicator=${streaming}  stop-btn=${stopBtn}`);
	if (stopBtn > 0 || streaming > 0) {
		console.log("  ✅ Agent is streaming");
		break;
	}
	await page.waitForTimeout(500);
}

await page.waitForTimeout(1500);

// Now send a second message while agent is busy
console.log("→ Sending second message (should queue)");
await ta.click();
await ta.fill("this is the second test for undo button");
await ta.press("Enter");
await page.waitForTimeout(500);

// Watch for queued bubble
console.log("→ Watching for queued bubble");
for (let i = 0; i < 16; i++) {
	const queuedCount = await page.locator('text=/· queued/').count();
	const cancelBtnCount = await page.locator('button[aria-label="Cancel queued prompt"]').count();
	const editBtnCount = await page.locator('button[aria-label="Edit queued prompt"]').count();
	const userBubbleCount = await page.locator('text=/second test for undo button/').count();
	console.log(`  t=${i * 500}ms  queued-label=${queuedCount}  user-bubble=${userBubbleCount}  cancel-btn=${cancelBtnCount}  edit-btn=${editBtnCount}`);
	if (queuedCount > 0) {
		console.log("  ✅ Found queued bubble!");
		await page.screenshot({ path: "/tmp/undo-visible.png", fullPage: true });
		console.log("  → /tmp/undo-visible.png");

		// Click cancel
		if (cancelBtnCount > 0) {
			console.log("  → Clicking cancel");
			await page.locator('button[aria-label="Cancel queued prompt"]').first().click();
			await page.waitForTimeout(1500);
			const after = await page.locator('button[aria-label="Cancel queued prompt"]').count();
			console.log(`  after cancel: cancel-btn=${after} (should be 0)`);
		}
		break;
	}
	await page.waitForTimeout(500);
}

await page.screenshot({ path: "/tmp/final.png", fullPage: true });
await browser.close();

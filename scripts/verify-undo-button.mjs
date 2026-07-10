import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

// Click "重新搜索loop" in sidebar
console.log("→ Clicking 重新搜索loop session");
const sessionBtn = page.locator("text=重新搜索loop").first();
const found = await sessionBtn.count();
console.log(`  found ${found} matches`);

if (found === 0) {
	await page.screenshot({ path: "/tmp/no-session.png", fullPage: true });
	console.log("→ no session button found, saved /tmp/no-session.png");
	await browser.close();
	process.exit(1);
}

await sessionBtn.click();
await page.waitForTimeout(2500);

// Check if textarea is now enabled
const ta = page.locator("textarea").first();
const enabled = await ta.isEnabled();
console.log(`  textarea enabled: ${enabled}`);

if (!enabled) {
	const placeholder = await ta.getAttribute("placeholder");
	console.log(`  placeholder: "${placeholder}"`);
}

await page.screenshot({ path: "/tmp/session-selected.png", fullPage: true });
console.log("→ /tmp/session-selected.png");

// Now type and send a message
console.log("→ Typing test message");
await ta.click();
await ta.fill("this is a test for the undo button — please respond");

console.log("→ Pressing Enter");
await ta.press("Enter");
await page.waitForTimeout(500);

// Watch for queued bubble
console.log("→ Watching for queued bubble (max 8s)");
for (let i = 0; i < 16; i++) {
	const queuedCount = await page.locator('text=/· queued/').count();
	const userBubbleCount = await page.locator('text=/test for the undo button/').count();
	const cancelBtnCount = await page.locator('button[aria-label="Cancel queued prompt"]').count();
	const editBtnCount = await page.locator('button[aria-label="Edit queued prompt"]').count();
	console.log(`  t=${i * 500}ms  queued-label=${queuedCount}  user-bubble=${userBubbleCount}  cancel-btn=${cancelBtnCount}  edit-btn=${editBtnCount}`);
	if (queuedCount > 0 && cancelBtnCount > 0) {
		console.log("  ✅ Found queued bubble with visible cancel button!");
		// Take a screenshot of the undo UI
		await page.screenshot({ path: "/tmp/undo-button-visible.png", fullPage: true });
		console.log("  → /tmp/undo-button-visible.png saved");
		// Try clicking cancel
		await page.locator('button[aria-label="Cancel queued prompt"]').first().click();
		await page.waitForTimeout(2000);
		const after = await page.locator('button[aria-label="Cancel queued prompt"]').count();
		console.log(`  after cancel: cancel-btn=${after} (should be 0)`);
		break;
	}
	await page.waitForTimeout(500);
}

await browser.close();

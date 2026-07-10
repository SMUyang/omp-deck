import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext().then((c) => c.newPage());

page.on("console", (msg) => {
	if (msg.type() === "error") console.log("  [browser-error]", msg.text());
});

console.log("→ Loading /");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

// Find a session id from the store via window globals; if not, click the first session in the sidebar
const sessionCount = await page.evaluate(() => {
	// Try to read from the zustand store via a known global if exposed
	return document.querySelectorAll('[data-session-id], aside button, nav button').length;
});
console.log(`  found ${sessionCount} session-nav candidates`);

// Click first item in the sidebar
const sidebarButtons = page.locator("aside button, nav button").first();
const sb = await sidebarButtons.count();
console.log(`  sidebar has ${sb} buttons`);
if (sb > 0) {
	await sidebarButtons.click();
	await page.waitForTimeout(1500);
}

// Look at textarea
const textarea = page.locator("textarea").first();
const taCount = await textarea.count();
console.log(`  textareas found: ${taCount}`);

if (taCount === 0) {
	console.log("  no textarea visible — taking screenshot for diagnosis");
	await page.screenshot({ path: "/tmp/omp-deck-no-textarea.png", fullPage: true });
	await browser.close();
	process.exit(1);
}

// Type a test prompt and click send
console.log("→ Typing test prompt");
await textarea.click();
await textarea.fill("test undo prompt — please respond quickly");
const sendBtn = page.locator('button[aria-label*="end"], button[title*="end"]').first();
const sendExists = await sendBtn.count();
console.log(`  send button: ${sendExists}`);

if (sendExists > 0) {
	console.log("→ Clicking send");
	await sendBtn.click();
	await page.waitForTimeout(500);
}

// Now wait for the queued message or a regular user message
console.log("→ Watching for queued/user message bubble (max 6s)");
for (let i = 0; i < 12; i++) {
	const queuedCount = await page.locator('text=/· queued/').count();
	const userBubbleCount = await page.locator('text=/test undo prompt/').count();
	const cancelBtnCount = await page.locator('button[aria-label="Cancel queued prompt"]').count();
	const editBtnCount = await page.locator('button[aria-label="Edit queued prompt"]').count();
	console.log(`  t=${i * 500}ms  queued-label=${queuedCount}  user-bubble=${userBubbleCount}  cancel-btn=${cancelBtnCount}  edit-btn=${editBtnCount}`);
	if (cancelBtnCount > 0) {
		console.log("  ✅ cancel button visible");
		// Click it to test the wiring
		await page.locator('button[aria-label="Cancel queued prompt"]').first().click();
		await page.waitForTimeout(1000);
		const after = await page.locator('button[aria-label="Cancel queued prompt"]').count();
		console.log(`  after click: cancel-btn=${after} (should drop)`);
		break;
	}
	await page.waitForTimeout(500);
}

await page.screenshot({ path: "/tmp/omp-deck-undo-test.png", fullPage: true });
console.log("→ screenshot saved to /tmp/omp-deck-undo-test.png");
await browser.close();

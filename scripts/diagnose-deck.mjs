import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());

console.log("→ Loading /");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// Full-page screenshot for diagnosis
await page.screenshot({ path: "/tmp/omp-deck-initial.png", fullPage: true });
console.log("→ Initial screenshot saved");

// Read the body text
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
console.log("→ Body text (first 2000 chars):");
console.log(bodyText);

// Check for new-session button
const newBtnCount = await page.locator('button:has-text("New"), button:has-text("new session"), button:has-text("New session")').count();
console.log(`→ New session button: ${newBtnCount}`);

// List all visible buttons
const allBtns = await page.evaluate(() => {
	return Array.from(document.querySelectorAll("button")).map((b) => ({
		text: b.textContent?.trim().slice(0, 40),
		disabled: b.disabled,
		visible: b.getBoundingClientRect().width > 0,
	}));
});
console.log("→ Visible buttons:");
for (const b of allBtns.filter((b) => b.visible).slice(0, 20)) {
	console.log(`   "${b.text}"${b.disabled ? " [disabled]" : ""}`);
}

await browser.close();

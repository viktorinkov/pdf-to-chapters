// Render the social-share OG card and the various platform app-icons from
// the templates in scripts/templates/. Run after any visual change to the
// brand mark.
//
//   node scripts/gen-social.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.dirname(__dirname);
const TEMPLATES = path.join(ROOT, "scripts/templates");
const SITE = path.join(ROOT, "site");
const PORT = 4178;

const server = spawn(
  "npx",
  ["http-server", TEMPLATES, "-p", String(PORT), "-c-1", "--silent"],
  { cwd: ROOT, stdio: "ignore" },
);

await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch();

async function render(template, outName, w, h) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/${template}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const out = path.join(SITE, outName);
  await page.screenshot({ path: out });
  await ctx.close();
  const rel = path.relative(ROOT, out);
  console.log(`  ${rel} (${w}x${h})`);
}

try {
  console.log("rendering social/icon assets...");
  // 1200x630: og:image (Facebook, LinkedIn, iMessage, Slack, Discord, etc.)
  //           and twitter:image with summary_large_image card.
  await render("og-card.html", "og.png", 1200, 630);

  // 180x180: apple-touch-icon for iOS Add-to-Home-Screen.
  await render("icon-card.html", "apple-touch-icon.png", 180, 180);

  // 192x192 + 512x512: PWA / Android Chrome home-screen icon (manifest).
  await render("icon-card.html", "icon-192.png", 192, 192);
  await render("icon-card.html", "icon-512.png", 512, 512);
  // Favicons keep using the existing favicon.svg — at 16-32px the wordmark
  // is illegible and the walnut-shape SVG is a better tiny mark anyway.

  console.log("done.");
} finally {
  await browser.close();
  server.kill();
}

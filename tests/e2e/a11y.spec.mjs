// Automated accessibility audit using axe-core.
//
// Runs against the same APP_URL the smoke spec does (live by default,
// overridable via WALNUT_APP_URL for CI's local server). Fails the test if
// axe surfaces any violations of impact "critical" or "serious" tagged with
// wcag2a/wcag2aa/best-practice. Lower-impact noise is allowed through so we
// can iterate on the surface without thrashing CI.
//
// We tolerate the empty-DOM lazy-load window before pdf.js mounts by waiting
// for networkidle before scanning.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const APP_URL = process.env.WALNUT_APP_URL || "https://viktorinkov.github.io/pdf-to-chapters/";

test("axe: home page has no critical or serious violations", async ({ page }) => {
  // The hero copy uses a CSS opacity transition (.reveal -> .reveal.in over
  // 600ms with up to 700ms delay). While in-flight, getComputedStyle returns
  // a fractional opacity, which makes axe report a transient color-contrast
  // failure on text that is otherwise WCAG-compliant in its resting state.
  // Emulate prefers-reduced-motion: reduce so the site's reduced-motion CSS
  // short-circuits all reveals to their final opacity-1 state and axe scans
  // the resting visual.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(APP_URL);
  await page.waitForLoadState("networkidle");
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "best-practice"])
    .analyze();
  const blocking = result.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  if (blocking.length > 0) {
    const formatted = blocking
      .map((v) => {
        const head = `[${v.impact}] ${v.id}: ${v.help}\n   ${v.helpUrl}\n   nodes: ${v.nodes.length}`;
        const detail = v.nodes
          .map(
            (n) =>
              `   - target: ${n.target.join(",")}\n     html:   ${(n.html || "").slice(0, 220)}\n     reason: ${(n.failureSummary || "").replace(/\n/g, " | ")}`,
          )
          .join("\n");
        return `${head}\n${detail}`;
      })
      .join("\n\n");
    throw new Error("axe a11y violations:\n\n" + formatted);
  }
  // Surface counts of all violations (including minor/moderate) for debugging.
  test
    .info()
    .annotations.push({
      type: "axe-summary",
      description: `total=${result.violations.length} blocking=${blocking.length}`,
    });
  expect(blocking).toHaveLength(0);
});

/**
 * Headless screenshots + checks for the settings window.
 *
 * Renders the app against a stubbed Tauri IPC in a browser, so nothing is
 * launched and no window appears on anyone's screen. Writes
 * ~/handy-review/ui-port/reverted-<screen>.png and prints what it checked.
 *
 * One shot per screen, not one per appearance: the app is dark and has no theme
 * setting. The browser context is deliberately given `colorScheme: "light"` so
 * every shot doubles as proof that the OS preference no longer reaches the UI.
 *
 *   bun scripts/ui-shots/shoot.mjs            # shoot + check
 *   bun scripts/ui-shots/shoot.mjs --check    # checks only, no PNGs
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(homedir(), "handy-review/ui-port");
const BASE = "http://localhost:1420";
// The window lib.rs opens, which is also its minimum — so every row is measured
// at the narrowest it is ever drawn.
const VIEWPORT = { width: 680, height: 570 };
const WIDE = { width: 1000, height: 760 };
const CHECK_ONLY = process.argv.includes("--check");

const fixtures = JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf8"));
const stubSource = readFileSync(join(HERE, "stub.js"), "utf8").replace(
  "export function",
  "function",
);

const results = [];
const record = (name, value, expected) => {
  const pass = expected === undefined || String(value) === String(expected);
  results.push({ name, value, expected, pass });
};

async function newPage(browser, viewport = VIEWPORT, fx = fixtures) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    // Light at the OS level, on purpose: the app must be dark anyway.
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ src, fx }) => {
      // eslint-disable-next-line no-eval
      eval(src);
      // eslint-disable-next-line no-undef
      installTauriStub(fx);
    },
    { src: stubSource, fx },
  );
  return page;
}

async function gotoApp(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=General", { timeout: 15000 });
  await page.waitForTimeout(400);
}

const shot = async (page, name) => {
  if (CHECK_ONLY) return;
  await page.screenshot({ path: join(OUT, `reverted-${name}.png`) });
  process.stdout.write(`  reverted-${name}.png\n`);
};

/** Click a sidebar entry by its visible label. */
const nav = async (page, label) => {
  await page.locator(`div.cursor-pointer:has(> p:text-is("${label}"))`).click();
  await page.waitForTimeout(400);
};

const pageText = (page) => page.evaluate(() => document.body.textContent ?? "");

/**
 * Every settings section, shot and swept for the rows Rem asked to be gone.
 * They live on three different pages, so the assertion is over the text of all
 * of them combined.
 */
async function shootSections(browser) {
  const page = await newPage(browser);
  await gotoApp(page);

  await checkForcedDark(page);

  let allText = "";
  for (const [label, slug] of [
    ["General", "general"],
    ["History", "history"],
    ["Models", "models"],
    ["Advanced", "advanced"],
    ["About", "about"],
  ]) {
    await nav(page, label);
    if (slug === "models") await page.waitForTimeout(600);
    await shot(page, slug);
    await checkNoOverflow(page, slug, VIEWPORT.width);
    if (slug === "models") await checkModels(page);
    if (slug === "advanced") {
      await checkOverlayOptions(page);
      await checkPathRow(page, VIEWPORT.width, false);
    }
    allText += await pageText(page);
  }

  checkRetiredRowsGone(allText);
  await page.context().close();
}

/** The same rows in a window with room to spare: the path must be whole here. */
async function shootWide(browser) {
  const page = await newPage(browser, WIDE);
  await gotoApp(page);
  await nav(page, "Advanced");
  await shot(page, "advanced-wide");
  await checkNoOverflow(page, "advanced", WIDE.width);
  await checkPathRow(page, WIDE.width, true);
  await page.context().close();
}

/**
 * The Debug section, which the fixture store has switched off — and where the
 * update-checks toggle used to live.
 */
async function shootDebug(browser) {
  const fx = {
    ...fixtures,
    settings: { ...fixtures.settings, debug_mode: true },
  };
  const page = await newPage(browser, WIDE, fx);
  await gotoApp(page);
  await nav(page, "Debug");
  await page.waitForTimeout(400);
  await shot(page, "debug");
  const text = await pageText(page);
  record(
    "removed: update-checks toggle",
    !/Check for Updates|Automatic Updates/i.test(text),
    "true",
  );
  await page.context().close();
}

/** The OS says light; the app must be dark anyway, and say so on the root. */
async function checkForcedDark(page) {
  const m = await page.evaluate(() => ({
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    dataTheme: document.documentElement.dataset.theme ?? "(none)",
    background: getComputedStyle(document.documentElement).backgroundColor,
  }));
  record("dark: OS preference is dark", m.prefersDark, "false");
  record("dark: data-theme", m.dataTheme, "dark");
  const channels = (m.background.match(/\d+/g) ?? []).map(Number).slice(0, 3);
  record("dark: root background", m.background);
  record(
    "dark: background is a dark value",
    channels.length === 3 && channels.every((c) => c < 90),
    "true",
  );
}

/**
 * The fixture store holds two of the three recommended models, so unbrowsed the
 * download list is the remaining one and nothing else — and the downloaded
 * Q8_0's catalog twin must not be offered underneath it.
 */
async function checkModels(page) {
  const m = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("h2")];
    const availableIdx = headings.findIndex((h) =>
      /Available to Download/.test(h.textContent ?? ""),
    );
    const names = (root) =>
      [...(root?.querySelectorAll("h3") ?? [])].map((h) =>
        h.textContent.trim(),
      );
    // Each section is a `space-y-3` block holding its heading and its cards.
    const section = (h) => h?.closest(".space-y-3");
    return {
      headings: headings.map((h) => h.textContent.trim()),
      downloaded: names(section(headings[0])),
      offered:
        availableIdx === -1 ? [] : names(section(headings[availableIdx])),
    };
  });
  record("models: sections", m.headings.join(" | "));
  record("models: downloaded", m.downloaded.join(" | "));
  record(
    "models: offered without searching",
    m.offered.join(" | "),
    "Canary 180M Flash",
  );
}

/**
 * The overlay row: None and Live, no Minimal — and a stored "minimal" reads as
 * Live, which is what the backend will have written by then.
 */
async function checkOverlayOptions(page) {
  const handle = await page.evaluateHandle(() => {
    const heading = [...document.querySelectorAll("h3")].find((h) =>
      /Overlay/i.test(h.textContent ?? ""),
    );
    return heading?.closest(".flex.items-center.justify-between") ?? null;
  });
  const row = handle.asElement();
  if (!row) {
    record("overlay: row found", false, "true");
    return;
  }
  const trigger = row.$("button");
  const button = await trigger;
  const shown = (await button.textContent())?.trim() ?? "(none)";
  await button.click();
  await page.waitForTimeout(250);
  const options = await page.evaluate(() => {
    const open = document.querySelector(".absolute.top-full");
    return open
      ? [...open.querySelectorAll("button")].map((b) => b.textContent.trim())
      : [];
  });
  record("overlay: stored minimal reads as", shown, "Live");
  record("overlay: options", options.join(" | "), "None | Live");
  await page.mouse.click(5, 5);
  await page.waitForTimeout(200);
}

/**
 * The recordings-folder row. `strict` asserts the last path segment survives
 * whole; at the app's minimum window width there is genuinely not room for it
 * beside two buttons, so that run only reports what happened. What must hold at
 * every width is that the buttons stay inside the card.
 */
async function checkPathRow(page, width, strict) {
  // The row is below the fold on a 570-tall window; measuring it is fine either
  // way, but the screenshot has to show it.
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h3")].find(
      (h) => h.textContent.trim() === "Recordings Folder",
    );
    heading?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(250);
  await shot(page, `recordings-folder-${width}`);
  const m = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h3")].find(
      (h) => h.textContent.trim() === "Recordings Folder",
    );
    const row = heading?.closest(".flex.items-center.justify-between");
    const value = row?.querySelector("span[title]");
    const parts = [...(value?.querySelectorAll("span") ?? [])];
    const [head, tail] = parts;
    // scrollWidth lies for an ellipsized inline flex item — Chrome lays the
    // clipped text out to fit and reports the two as equal. A Range over the
    // text nodes measures what the string actually wants.
    const inkWidth = (el) => {
      if (!el) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const buttons = [...(row?.querySelectorAll("button") ?? [])].filter((b) =>
      /Choose|Default/.test(b.textContent ?? ""),
    );
    const card = row?.parentElement;
    return {
      found: Boolean(row),
      tailText: tail?.textContent ?? "",
      headTruncated: inkWidth(head) > (head?.clientWidth ?? 0) + 1,
      tailTruncated: inkWidth(tail) > (tail?.clientWidth ?? 0) + 1,
      buttonLabels: buttons.map((b) => b.textContent.trim()),
      buttonsInside:
        card && buttons.length
          ? buttons.every(
              (b) =>
                b.getBoundingClientRect().right <=
                card.getBoundingClientRect().right + 0.6,
            )
          : null,
    };
  });
  record(`path @${width}: row found`, m.found, "true");
  record(`path @${width}: tail segment`, m.tailText || "(none)");
  record(`path @${width}: buttons`, m.buttonLabels.join(" | "));
  record(`path @${width}: buttons inside the card`, m.buttonsInside, "true");
  record(`path @${width}: head gives way first`, m.headTruncated, "true");
  if (strict) record(`path @${width}: tail whole`, !m.tailTruncated, "true");
  else record(`path @${width}: tail also clipped`, m.tailTruncated);
}

/**
 * Nothing on a settings page may stick out of its parent. `truncate` on a flex
 * child only works when every ancestor between it and the row is `min-w-0`,
 * which is the class of bug this catches.
 */
async function checkNoOverflow(page, slug, width) {
  const spills = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const parent = el.parentElement;
      if (!parent) continue;
      const style = getComputedStyle(el);
      if (style.position === "absolute" || style.position === "fixed") continue;
      if (getComputedStyle(parent).overflowX !== "visible") continue;
      const box = el.getBoundingClientRect();
      const parentBox = parent.getBoundingClientRect();
      if (!box.width || !parentBox.width) continue;
      if (
        box.right > parentBox.right + 0.6 ||
        box.left < parentBox.left - 0.6
      ) {
        out.push(
          `${el.tagName} "${(el.textContent ?? "").trim().slice(0, 34)}" ` +
            `right=${box.right.toFixed(0)} parent=${parentBox.right.toFixed(0)}`,
        );
      }
    }
    return out.slice(0, 6);
  });
  record(`overflow @${width}: ${slug}`, spills.length, 0);
  if (spills.length) results.at(-1).detail = spills;
}

/** Rows Rem asked to be gone must be gone, not merely defaulted. */
function checkRetiredRowsGone(allText) {
  const absent = (needle) => !allText.includes(needle);
  record("removed: Application Theme row", absent("Application Theme"), "true");
  record("removed: What's New row", absent("What's New"), "true");
  record(
    "removed: Support Development row",
    absent("Support Development"),
    "true",
  );
  record("removed: Experimental row", absent("Experimental"), "true");
  record(
    "removed: Voice Activity Detection row",
    absent("Voice Activity Detection"),
    "true",
  );
  record("removed: filler-word row", absent("Filler"), "true");
  record(
    "kept: Application Language row",
    allText.includes("Application Language"),
    "true",
  );
}

/** The recording pill: black fill, white bars, whatever the OS is set to. */
async function shootOverlay(browser) {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 420, height: 140 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();
    await page.addInitScript(
      ({ src, fx }) => {
        // eslint-disable-next-line no-eval
        eval(src);
        // eslint-disable-next-line no-undef
        installTauriStub(fx);
      },
      { src: stubSource, fx: fixtures },
    );
    await page.goto(`${BASE}/src/overlay/index.html`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => {
      window.__fsEmit("show-overlay", "recording");
      // Without this the bars sit in the dimmed "arming" state, which is white
      // at 25% — still white ink, but not the value to assert on.
      window.__fsEmit("recording-ready", null);
    });
    await page.waitForSelector(".wpill");
    await page.waitForTimeout(600);

    const colors = await page.evaluate(() => {
      const pill = document.querySelector(".wpill");
      const bar = document.querySelector(".wpill i");
      return {
        dataTheme: document.documentElement.dataset.theme ?? "(none)",
        pill: getComputedStyle(pill).backgroundColor,
        bar: bar ? getComputedStyle(bar).backgroundColor : null,
      };
    });
    // The bar's alpha rides an animation, so compare the hue, not the string.
    const channels = (colors.bar ?? "").match(/[\d.]+/g)?.slice(0, 3) ?? [];
    const isWhite =
      channels.length === 3 &&
      channels.every((c) => Number(c) === 1 || Number(c) === 255);
    record(
      `flow bar (OS ${theme}, data-theme=${colors.dataTheme}): pill`,
      colors.pill,
      "rgb(0, 0, 0)",
    );
    record(`flow bar (OS ${theme}): bars are white`, isWhite, "true");
    if (!CHECK_ONLY) {
      await page.screenshot({
        path: join(OUT, `reverted-flowbar-${theme}.png`),
      });
      process.stdout.write(`  reverted-flowbar-${theme}.png\n`);
    }
    await context.close();
  }
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
await shootSections(browser);
await shootWide(browser);
await shootDebug(browser);
await shootOverlay(browser);
await browser.close();

let failed = 0;
process.stdout.write("\nchecks\n");
for (const r of results) {
  const mark = r.expected === undefined ? "   " : r.pass ? " ok" : "FAIL";
  if (!r.pass) failed++;
  process.stdout.write(
    `${mark}  ${r.name}: ${r.value}` +
      (r.expected !== undefined && !r.pass ? `  (want ${r.expected})` : "") +
      "\n",
  );
  if (r.detail)
    for (const d of r.detail) process.stdout.write(`        ${d}\n`);
}
process.stdout.write(failed ? `\n${failed} failing\n` : "\nall checks pass\n");
process.exit(failed ? 1 : 0);

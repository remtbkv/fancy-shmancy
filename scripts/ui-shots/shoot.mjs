/**
 * Headless screenshots + geometry checks for the ported UI.
 *
 * Renders the app against a stubbed Tauri IPC in a browser at the reference's
 * 1350x850 and 2x, so nothing is launched and no window appears on anyone's
 * screen. Writes ~/handy-review/ui-port/<screen>-<theme>.png and prints the
 * measurements the port is supposed to hit.
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
const VIEWPORT = { width: 1350, height: 850 };
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

async function newPage(browser, theme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ src, fx, th }) => {
      // eslint-disable-next-line no-eval
      eval(src);
      // eslint-disable-next-line no-undef
      installTauriStub(fx, th);
    },
    { src: stubSource, fx: fixtures, th: theme },
  );
  return page;
}

async function gotoApp(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("nav", { timeout: 15000 });
  await page.waitForTimeout(400);
}

const shot = async (page, name) => {
  if (CHECK_ONLY) return;
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  process.stdout.write(`  ${name}.png\n`);
};

/** Click a sidebar entry by its visible label. */
const nav = async (page, label) => {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(350);
};

async function shootApp(browser, theme) {
  const page = await newPage(browser, theme);
  await gotoApp(page);

  await shot(page, `home-${theme}`);
  if (theme === "light") await measureHome(page);

  await nav(page, "Dictionary");
  await shot(page, `dictionary-${theme}`);

  await nav(page, "Models");
  await page.waitForTimeout(500);
  await shot(page, `models-${theme}`);
  if (theme === "light") await checkModels(page);

  await nav(page, "About");
  await shot(page, `about-${theme}`);

  // Settings modal, one shot per page.
  await nav(page, "Dictation");
  if (theme === "light") await measureModalEnter(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(400);

  // By position, not by label: the accessible name of "History & Storage"
  // does not survive role-name matching, and the order is the contract anyway.
  const modalNav = page.locator('[role="dialog"] nav button');
  const slugs = ["general", "system", "storage", "advanced"];
  for (let i = 0; i < slugs.length; i++) {
    await modalNav.nth(i).click();
    await page.waitForTimeout(300);
    await shot(page, `settings-${slugs[i]}-${theme}`);
  }

  if (theme === "light") await checkSettingsPages(page);
  if (theme === "light") await checkNoGold(page);

  await page.context().close();
}

async function measureHome(page) {
  const m = await page.evaluate(() => {
    const card = document.querySelector("main > div");
    const cardBox = card.getBoundingClientRect();
    const rows = [...document.querySelectorAll("main .group")];
    const first = rows[0]?.getBoundingClientRect();
    const second = rows[1]?.getBoundingClientRect();
    const stamp = rows[0]?.firstElementChild;
    const eyebrow = document.querySelector("main .uppercase");
    return {
      cardPadding: parseFloat(getComputedStyle(card).paddingLeft),
      cardRadius: parseFloat(getComputedStyle(card).borderTopLeftRadius),
      cardBg: getComputedStyle(card).backgroundColor,
      rowHeight: first ? Math.round(first.height) : null,
      rowPitch: first && second ? Math.round(second.top - first.top) : null,
      stampWidth: stamp
        ? Math.round(stamp.getBoundingClientRect().width)
        : null,
      stampSize: stamp ? getComputedStyle(stamp).fontSize : null,
      eyebrowSize: eyebrow ? getComputedStyle(eyebrow).fontSize : null,
      eyebrowTracking: eyebrow ? getComputedStyle(eyebrow).letterSpacing : null,
      eyebrowToRow:
        eyebrow && first
          ? Math.round(first.top - eyebrow.getBoundingClientRect().bottom)
          : null,
      sidebarWidth: Math.round(
        document.querySelector("nav").getBoundingClientRect().width,
      ),
      // The two fixture rows with no transcript must say something.
      emptyRowText: rows
        .map((r) => r.children[1]?.textContent?.trim())
        .filter((t) => t === "Cancelled" || t === "Transcription failed"),
      greetingGone: !document.body.textContent.includes(
        "Get back into the flow",
      ),
      statsLine: document.querySelector("main p")?.textContent?.trim() ?? null,
      cardLeft: Math.round(cardBox.left),
    };
  });

  record("home: sidebar width", m.sidebarWidth, 216);
  record("home: card padding", m.cardPadding, 40);
  record("home: card radius", m.cardRadius, 24);
  record("home: row height", m.rowHeight, 53);
  record("home: row pitch", m.rowPitch, 53);
  record("home: timestamp column", m.stampWidth, 97);
  record("home: timestamp size", m.stampSize, "13px");
  record("home: eyebrow size", m.eyebrowSize, "12px");
  record("home: eyebrow tracking", m.eyebrowTracking, "0.96px");
  record("home: eyebrow ink -> first row", m.eyebrowToRow);
  record("home: greeting removed", m.greetingGone, "true");
  record("home: stats line", m.statsLine);
  record("home: empty rows labelled", m.emptyRowText.length >= 2, "true");
}

async function checkModels(page) {
  const m = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("main h2")].map((h) =>
      h.textContent.trim(),
    );
    const names = [...document.querySelectorAll("main h3")].map((h) =>
      h.textContent.trim(),
    );
    const availableIndex = headings.findIndex(
      (h) => h === "Recommended" || h === "Available to Download",
    );
    return { headings, names, availableIndex };
  });
  // The downloaded Q8_0 is Cohere Transcribe; its catalog twin must not be
  // offered underneath it.
  const downloadedBase = m.names
    .filter((n) => n.includes("(Q8_0)"))
    .map((n) => n.replace(" (Q8_0)", ""));
  const offeredTwins = downloadedBase.filter(
    (base) => m.names.filter((n) => n === base).length > 0,
  );
  record("models: sections", m.headings.join(" | "));
  record("models: cards", m.names.join(" | "));
  record("models: downloaded twin re-offered", offeredTwins.length, 0);
  record(
    "models: download list is the trio",
    m.names.length - downloadedBase.length <= 3,
    "true",
  );
}

async function checkSettingsPages(page) {
  const pages = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] nav button')].map((b) =>
      b.textContent.trim(),
    ),
  );
  record(
    "settings: pages",
    pages.join(" | "),
    "General | System | History & Storage | Advanced",
  );
  const hasModelsGroup = await page.evaluate(() =>
    document.body.textContent.includes("Models and performance"),
  );
  record("settings: engine rows on Advanced", hasModelsGroup, "true");

  // A SettingRow's subtitle is the current value. A blank one means the row
  // cannot read what is stored — which is how the unload-timeout spelling
  // mismatch showed up in the first place.
  const unload = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[role="dialog"] div')].find(
      (d) => d.children[0]?.children[0]?.textContent?.trim() === "Unload Model",
    );
    return row?.children[0]?.children[1]?.textContent?.trim() ?? "(row absent)";
  });
  record("settings: unload row shows its value", unload || "(blank)");
  record("settings: unload row not blank", Boolean(unload), "true");
}

/** The sheet has to be mid-transition partway through its enter, not already
 *  there — the bug was the transition being skipped, not being short. */
async function measureModalEnter(page) {
  const samples = await page.evaluate(async () => {
    const sheet = () => document.querySelector('[role="dialog"]');
    const btn = [...document.querySelectorAll("nav button")].find(
      (b) => b.textContent.trim() === "Settings",
    );
    btn.click();
    const readings = [];
    const t0 = performance.now();
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = sheet();
      if (el) {
        readings.push({
          t: Math.round(performance.now() - t0),
          opacity: parseFloat(getComputedStyle(el).opacity),
          transform: getComputedStyle(el).transform,
        });
      }
    }
    return readings;
  });
  const mid = samples.filter((s) => s.opacity > 0.02 && s.opacity < 0.98);
  const settled = samples.find((s) => s.opacity > 0.99);
  record("modal: intermediate opacity frames", mid.length);
  record("modal: animates (not a jump)", mid.length >= 3, "true");
  record("modal: settled at ms", settled ? settled.t : "never");
  record(
    "modal: scale animates",
    new Set(samples.map((s) => s.transform)).size > 2,
    "true",
  );
  // Close it again so the caller starts from a known state.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

/** No pixel anywhere should still be the old brand gold. */
async function checkNoGold(page) {
  const hits = await page.evaluate(() => {
    const golds = ["168, 128, 31", "224, 190, 99"];
    const found = [];
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      for (const prop of [
        "color",
        "backgroundColor",
        "borderTopColor",
        "fill",
      ]) {
        const v = s[prop];
        if (golds.some((g) => v && v.includes(g))) {
          found.push(
            `${el.tagName}.${el.className}`.slice(0, 60) + ` ${prop}=${v}`,
          );
        }
      }
    }
    return found.slice(0, 10);
  });
  record("gold: computed-style hits", hits.length, 0);
  if (hits.length) results.at(-1).detail = hits;
}

/** The recording pill: black fill, white bars, in both appearances and with the
 *  app theme forced either way. */
async function shootOverlay(browser) {
  for (const theme of ["light", "dark"]) {
    const page = await newPage(browser, theme);
    await page.setViewportSize({ width: 420, height: 140 });
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
      `flow bar (${theme}, data-theme=${colors.dataTheme}): pill`,
      colors.pill,
      "rgb(0, 0, 0)",
    );
    record(`flow bar (${theme}): bars are white`, isWhite, "true");
    if (!CHECK_ONLY) {
      await page.screenshot({
        path: join(OUT, `flowbar-${theme}.png`),
        omitBackground: false,
      });
      process.stdout.write(`  flowbar-${theme}.png\n`);
    }
    await page.context().close();
  }
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
for (const theme of ["light", "dark"]) {
  process.stdout.write(`${theme}:\n`);
  await shootApp(browser, theme);
}
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

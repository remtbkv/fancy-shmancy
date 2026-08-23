/**
 * Headless screenshots + geometry checks for the ported UI.
 *
 * Renders the app against a stubbed Tauri IPC in a browser at the reference's
 * 1350x850 and 2x, so nothing is launched and no window appears on anyone's
 * screen. Writes ~/handy-review/ui-port/<screen>.png and prints the
 * measurements the port is supposed to hit.
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

async function newPage(
  browser,
  theme,
  viewport = VIEWPORT,
  fx = fixtures,
  os = "macos",
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ src, fx, os }) => {
      // eslint-disable-next-line no-eval
      eval(src);
      // eslint-disable-next-line no-undef
      installTauriStub(fx);
      window.__TAURI_OS_PLUGIN_INTERNALS__.platform = os;
      window.__TAURI_OS_PLUGIN_INTERNALS__.os_type = os;
    },
    { src: stubSource, fx, os },
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

/** Open the settings sheet and land on one of its four pages, by index. */
async function openSettings(page, index) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(400);
  // By position, not by label: the accessible name of "History & Storage"
  // does not survive role-name matching, and the order is the contract anyway.
  await page.locator('[role="dialog"] nav button').nth(index).click();
  await page.waitForTimeout(300);
}

async function shootApp(browser) {
  // Light at the OS level, on purpose — see the file header.
  const page = await newPage(browser, "light");
  await gotoApp(page);

  await shot(page, "home");
  await measureHome(page);
  await checkForcedDark(page);

  await nav(page, "Dictionary");
  await shot(page, "dictionary");

  await nav(page, "Models");
  await page.waitForTimeout(500);
  await shot(page, "models");
  await checkModels(page);

  await nav(page, "About");
  await shot(page, "about");
  await checkAboutRowsGone(page);

  await nav(page, "Dictation");
  await measureModalEnter(page);

  const slugs = ["general", "system", "storage", "advanced"];
  let allPagesText = "";
  for (let i = 0; i < slugs.length; i++) {
    if (i === 0) await openSettings(page, i);
    else {
      await page.locator('[role="dialog"] nav button').nth(i).click();
      await page.waitForTimeout(300);
    }
    await shot(page, `settings-${slugs[i]}`);
    await checkNoOverflow(page, slugs[i], VIEWPORT.width);
    if (slugs[i] === "system") await checkOverlayRow(page);
    if (slugs[i] === "storage") await checkPathTail(page, "1350", true);
    allPagesText += await page.evaluate(
      () => document.querySelector('[role="dialog"]').textContent ?? "",
    );
  }

  await checkSettingsPages(page);
  checkRetiredRowsGone(allPagesText);
  await checkNoGold(page);

  await page.context().close();
}

/**
 * The same four pages in a window at the app's minimum size (680x570, from
 * `lib.rs`). The sheet is capped at `100vw - 32`, so this is the narrowest a
 * SettingRow ever gets — where a value that will not shrink pushes the row's
 * control out of the card.
 */
async function shootNarrow(browser) {
  const page = await newPage(browser, "light", { width: 680, height: 570 });
  await gotoApp(page);
  for (let i = 0; i < 4; i++) {
    if (i === 0) await openSettings(page, i);
    else {
      await page.locator('[role="dialog"] nav button').nth(i).click();
      await page.waitForTimeout(300);
    }
    const slug = ["general", "system", "storage", "advanced"][i];
    await checkNoOverflow(page, slug, 680);
    if (slug === "storage") {
      await shot(page, "settings-storage-narrow");
      await checkPathTail(page, "680", false);
    }
  }
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
    // Everything after the "available" heading is what is being offered.
    const sections = [...document.querySelectorAll("main h2, main h3")];
    const start = sections.findIndex(
      (el) =>
        el.tagName === "H2" &&
        /Recommended|Available to Download/.test(el.textContent),
    );
    const offered =
      start === -1
        ? []
        : sections
            .slice(start + 1)
            .filter((el) => el.tagName === "H3")
            .map((el) => el.textContent.trim());
    return { headings, names, offered };
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
  // The fixture holds two of the three recommended models, so unbrowsed the
  // download list is the remaining one and nothing else.
  record(
    "models: offered without searching",
    m.offered.join(" | "),
    "Canary 180M Flash",
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

/** The OS says light; the app must be dark anyway, and say so on the root. */
async function checkForcedDark(page) {
  const m = await page.evaluate(() => ({
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    dataTheme: document.documentElement.dataset.theme ?? "(none)",
    // The sidebar paints the canvas token; `body` is transparent, so reading it
    // would pass on `rgba(0,0,0,0)` without proving anything.
    canvas: getComputedStyle(document.querySelector("nav")).backgroundColor,
  }));
  record("dark: OS preference is dark", m.prefersDark, "false");
  record("dark: data-theme", m.dataTheme, "dark");
  // The dark canvas token; a light canvas would read near 245,244,241.
  const channels = (m.canvas.match(/\d+/g) ?? []).map(Number).slice(0, 3);
  record("dark: body background", m.canvas);
  record(
    "dark: canvas is a dark value",
    channels.length === 3 && channels.every((c) => c < 90),
    "true",
  );
}

/**
 * Nothing inside the sheet may stick out of its parent. `truncate` on a flex
 * child only works when every ancestor between it and the row is `min-w-0`,
 * which is the class of bug this catches — the row's title was the one that
 * escaped.
 */
async function checkNoOverflow(page, slug, width) {
  const spills = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const out = [];
    for (const el of dialog.querySelectorAll("*")) {
      const parent = el.parentElement;
      if (!parent) continue;
      const box = el.getBoundingClientRect();
      const parentBox = parent.getBoundingClientRect();
      // A scroll container is allowed to be taller than its parent; only
      // horizontal escape is the bug here.
      if (getComputedStyle(parent).overflowX !== "visible") continue;
      if (!box.width) continue;
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

/**
 * The point of middle-truncating a path: the folder name survives while the
 * `/Users/you/Library/...` prefix goes. `strict` asserts the tail is whole; at
 * the app's minimum window width there is genuinely not room for it beside two
 * buttons, so that run only reports what happened.
 */
async function checkPathTail(page, label, strict) {
  const m = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[role="dialog"] div')].find(
      (d) =>
        d.children[0]?.children[0]?.textContent?.trim() === "Recordings Folder",
    );
    const value = row?.children[0]?.children[1];
    const parts = [...(value?.querySelectorAll("span") ?? [])];
    const [head, tail] = [parts[1], parts[2]];
    // scrollWidth lies for an ellipsized inline flex item — Chrome lays the
    // clipped text out to fit and reports the two as equal. A Range over the
    // text nodes measures what the string actually wants.
    const inkWidth = (el) => {
      if (!el) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const card = row?.parentElement;
    const buttons = row?.children[1];
    return {
      headText: head?.textContent ?? "",
      tailText: tail?.textContent ?? "",
      headTruncated: inkWidth(head) > (head?.clientWidth ?? 0) + 1,
      tailTruncated: inkWidth(tail) > (tail?.clientWidth ?? 0) + 1,
      buttonsInside:
        card && buttons
          ? buttons.getBoundingClientRect().right <=
            card.getBoundingClientRect().right + 0.6
          : null,
    };
  });
  record(`path @${label}: tail segment`, m.tailText || "(none)");
  record(`path @${label}: head gives way first`, m.headTruncated, "true");
  record(`path @${label}: buttons inside the card`, m.buttonsInside, "true");
  if (strict) record(`path @${label}: tail whole`, !m.tailTruncated, "true");
  else record(`path @${label}: tail also clipped`, m.tailTruncated);
}

/**
 * Rows Rem asked to be gone must be gone, not merely defaulted — and each lives
 * on a different page, so this asserts over the text of all four combined.
 */
function checkRetiredRowsGone(allPagesText) {
  const absent = (needle) => !allPagesText.includes(needle);
  record("removed: Application Theme row", absent("Application Theme"), "true");
  record("removed: What's New row", absent("What's New"), "true");
  record("removed: Experimental row", absent("Experimental"), "true");
  record(
    "removed: Voice Activity Detection row",
    absent("Voice Activity Detection"),
    "true",
  );
  record("removed: Remove filler words row", absent("filler"), "true");
}

/** The System page's Overlay row, whose fixture value is the retired "minimal". */
async function checkOverlayRow(page) {
  const m = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[role="dialog"] div')].find(
      (d) => d.children[0]?.children[0]?.textContent?.trim() === "Overlay",
    );
    const options = [
      ...document.querySelectorAll('[role="dialog"] option'),
    ].map((o) => o.textContent.trim());
    return {
      value: row?.children[0]?.children[1]?.textContent?.trim() ?? "(no row)",
      options,
    };
  });
  record("overlay: stored minimal reads as", m.value, "Live");
  if (m.options.length) record("overlay: options", m.options.join(" | "));
}

/** Same three, on the main window's About page. */
async function checkAboutRowsGone(page) {
  const text = await page.evaluate(() => document.body.textContent ?? "");
  record("about: theme row gone", text.includes("Application Theme"), "false");
  record("about: what's new row gone", text.includes("What's New"), "false");
  record(
    "about: support development gone",
    text.includes("Support Development"),
    "false",
  );
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

/**
 * First run: onboarding un-done and nothing on disk, so the model step shows
 * the curated set and nothing else.
 *
 * Reported as Linux, which is not cosmetic. `AccessibilityOnboarding`'s mount
 * effect depends on `onComplete`, and App.tsx passes an unmemoized callback, so
 * on macOS the two re-trigger each other until the parent unmounts the
 * component ~300ms later. In the app that is a burst nobody sees; headless it
 * exceeds React's update depth and takes the tab down. Linux takes the branch
 * that skips permissions entirely, which is the same model step. (The loop is
 * pre-existing and untouched by this round.)
 */
async function shootOnboarding(browser) {
  const fresh = {
    ...fixtures,
    settings: { ...fixtures.settings, onboarding_completed: false },
    models: fixtures.models
      .filter((m) => !m.name.includes("(Q8_0)"))
      .map((m) => ({ ...m, is_downloaded: false })),
  };
  const page = await newPage(browser, "light", VIEWPORT, fresh, "linux");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "onboarding-models");

  const offered = await page.evaluate(() =>
    [...document.querySelectorAll("h3")].map((h) => h.textContent.trim()),
  );
  record(
    "onboarding: the curated set",
    offered.join(" | "),
    "Cohere Transcribe | Canary 1B Flash | Canary 180M Flash",
  );
  await page.context().close();
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
await shootApp(browser);
await shootNarrow(browser);
await shootOnboarding(browser);
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

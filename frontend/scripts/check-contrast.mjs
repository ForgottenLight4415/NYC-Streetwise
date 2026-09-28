import { readFileSync } from "node:fs";

const css = readFileSync(process.argv[2], "utf8");

function blockFor(selector) {
  const i = css.indexOf(selector);
  if (i === -1) throw new Error(`missing ${selector}`);
  const start = css.indexOf("{", i);
  let depth = 0, j = start;
  for (; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") { depth--; if (depth === 0) break; }
  }
  const body = css.slice(start, j);
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// Light = bare :root; dark = :root[data-theme="dark"] layered on top of it.
const light = blockFor(":root {");
const dark = { ...light, ...blockFor(':root[data-theme="dark"]') };

const hex = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  return m ? m[1] : null;
};

const lum = (h) => {
  const c = [0, 2, 4].map((i) => {
    const s = parseInt(h.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum, what it is]
const TEXT = 4.5, GRAPHIC = 3;
const pairs = [
  ["--text-primary", "--surface-1", TEXT, "body text on cards"],
  ["--text-secondary", "--surface-1", TEXT, "secondary text on cards"],
  ["--text-muted", "--surface-1", TEXT, "muted text on cards"],
  ["--text-primary", "--background", TEXT, "body text on page"],
  ["--text-secondary", "--background", TEXT, "secondary text on page"],
  ["--text-muted", "--background", TEXT, "muted text on page"],
  ["--text-primary", "--surface-2", TEXT, "text on subtle fill"],
  ["--text-muted", "--surface-2", TEXT, "muted text on subtle fill"],

  ["--brand", "--surface-1", TEXT, "link/brand text on cards"],
  ["--brand", "--background", TEXT, "link/brand text on page"],
  ["--brand-strong", "--surface-1", TEXT, "brand hover text"],

  ["--series-building-ink", "--surface-1", TEXT, "building label text"],
  ["--series-block-ink", "--surface-1", TEXT, "block label text"],
  ["--series-building", "--surface-1", GRAPHIC, "building bar/arc"],
  ["--series-block", "--surface-1", GRAPHIC, "block bar/arc"],

  ["--status-good-ink", "--surface-1", TEXT, "Good as text"],
  ["--status-warning-ink", "--surface-1", TEXT, "Fair as text"],
  ["--status-critical-ink", "--surface-1", TEXT, "Poor as text"],
  ["--status-serious-ink", "--surface-1", TEXT, "Serious as text"],
  ["--status-good", "--surface-1", GRAPHIC, "Good arc/dot"],
  ["--status-warning", "--surface-1", GRAPHIC, "Fair arc/dot"],
  ["--status-critical", "--surface-1", GRAPHIC, "Poor arc/dot"],

  ["--border-strong", "--surface-1", GRAPHIC, "input border"],
  ["--border-strong", "--background", GRAPHIC, "input border on page"],
];

// Score blobs and solid buttons put white text on a saturated fill.
const onFill = [
  ["--brand", "primary button"],
  ["--status-good-ink", "Good score blob"],
  ["--status-warning-ink", "Fair score blob"],
  ["--status-critical-ink", "Poor score blob"],
  ["--series-building-ink", "building score blob"],
  ["--series-block-ink", "block score blob"],
];

let failures = 0;
for (const [name, tokens] of [["LIGHT", light], ["DARK", dark]]) {
  console.log(`\n=== ${name} ===`);
  for (const [fg, bg, min, label] of pairs) {
    const [a, b] = [hex(tokens[fg]), hex(tokens[bg])];
    if (!a || !b) { console.log(`  ?? ${label} — non-hex token`); continue; }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${r.toFixed(2).padStart(5)} (need ${min})  ${label}`);
  }
  for (const [fill, label] of onFill) {
    const f = hex(tokens[fill]);
    // Dark theme uses dark text on its lighter fills; light theme uses white.
    const ink = name === "LIGHT" ? "ffffff" : hex(tokens["--surface-1"]);
    const r = ratio(ink, f);
    const ok = r >= TEXT;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${r.toFixed(2).padStart(5)} (need ${TEXT})  ${label} (text on fill)`);
  }
}

console.log(`\n${failures === 0 ? "All pairs pass." : `${failures} FAILING pair(s).`}`);
process.exit(failures === 0 ? 0 : 1);

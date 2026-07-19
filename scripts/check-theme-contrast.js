const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "public", "style_v2.css"), "utf8");

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Missing theme token --${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function requireAa(name, foreground, background) {
  const ratio = contrast(foreground, background);
  if (ratio < 4.5) {
    throw new Error(`${name} contrast is ${ratio.toFixed(2)}; expected at least 4.5`);
  }
  process.stdout.write(`${name}: ${ratio.toFixed(2)}:1\n`);
}

requireAa("primary text", token("ink"), token("night"));
requireAa("muted text", token("muted"), token("night"));
requireAa("muted panel text", token("muted"), token("panel"));
requireAa("cyan accent", token("cyan"), token("night"));
requireAa("cyan panel accent", token("cyan"), token("panel"));
requireAa("semantic green", token("green"), token("panel"));
requireAa("danger text", token("danger"), token("panel"));

import assert from "node:assert/strict";
import {
  normalizeSystemFontNames,
  parseFontconfigList,
  parseMacFontList,
  parseWindowsFontList,
} from "../dist-electron/electron/system-fonts.js";

assert.deepEqual(parseWindowsFontList('["Consolas","Cascadia Mono","consolas"]'), ["Cascadia Mono", "Consolas"]);
assert.deepEqual(parseWindowsFontList('"JetBrains Mono"'), ["JetBrains Mono"]);
assert.deepEqual(parseWindowsFontList("not-json"), []);

assert.deepEqual(
  parseFontconfigList("DejaVu Sans Mono,DejaVu Sans Mono\nNoto Sans\n"),
  ["DejaVu Sans Mono", "Noto Sans"],
);
assert.deepEqual(
  parseMacFontList(JSON.stringify({ SPFontsDataType: [{ family: "Menlo" }, { family_name: "SF Mono" }] })),
  ["Menlo", "SF Mono"],
);
assert.deepEqual(normalizeSystemFontNames([" Demo.ttf ", "demo", "", null, "bad\nfont"]), ["Demo"]);

console.log("system-fonts: Windows, fontconfig, and macOS font catalogs passed");

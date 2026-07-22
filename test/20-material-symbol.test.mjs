// test/20-material-symbol.test.mjs
// Covers: the MaterialSymbol wrapper (components/ui/MaterialSymbol.tsx) — variable-axis
// prop mapping, clamping, defaults, and the accessibility contract (always aria-hidden,
// no accessible-name prop of its own). Rendered via react-dom/server (renderToStaticMarkup)
// rather than a DOM testing library, since the project has no such dependency yet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { importTsx } from "./helpers/tsx-loader.mjs";

const COMPONENT_PATH = new URL("../components/ui/MaterialSymbol.tsx", import.meta.url).pathname;
const { MaterialSymbol } = await importTsx(COMPONENT_PATH);

function render(props) {
  return renderToStaticMarkup(createElement(MaterialSymbol, props));
}

// renderToStaticMarkup HTML-escapes attribute values (' -> &#x27;); unescape before
// matching so assertions read like the actual CSS value rather than its HTML encoding.
function styleAttr(html) {
  const match = html.match(/style="([^"]*)"/);
  return match[1].replaceAll("&#x27;", "'");
}

test("renders the ligature name as text content with the base class", () => {
  const html = render({ name: "home" });
  assert.match(html, /class="material-symbols-rounded"/);
  assert.match(html, />home</);
});

test("is always aria-hidden and never exposes its own accessible-name prop", () => {
  const html = render({ name: "close" });
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /aria-label/);
});

test("defaults: size 24, outline (FILL 0), weight 400, grade 0, opsz = size", () => {
  const html = render({ name: "home" });
  const style = styleAttr(html);
  assert.match(style, /font-size:24px/);
  assert.match(style, /'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24/);
});

test("maps fill/weight/grade/opticalSize onto the four variable axes", () => {
  const html = render({ name: "home", size: 48, fill: true, weight: 700, grade: 200, opticalSize: 40 });
  const style = styleAttr(html);
  assert.match(style, /font-size:48px/);
  assert.match(style, /'FILL' 1, 'wght' 700, 'GRAD' 200, 'opsz' 40/);
});

test("clamps out-of-range axis values instead of emitting invalid CSS", () => {
  const html = render({ name: "home", weight: 9999, grade: -9999, opticalSize: 1 });
  const style = styleAttr(html);
  assert.match(style, /'wght' 700/); // clamped to max 700
  assert.match(style, /'GRAD' -25/); // clamped to min -25
  assert.match(style, /'opsz' 20/); // clamped to min 20
});

test("merges a caller-supplied className alongside the base class", () => {
  const html = render({ name: "home", className: "text-action-on-primary" });
  assert.match(html, /class="material-symbols-rounded text-action-on-primary"/);
});

#!/usr/bin/env node
// assert-styles.mjs — computed-style assertion gate (NO browser; pure comparison).
//
// The QA agent opens the localhost clone with the Claude Chrome extension and reads
// the clone's computed styles via `javascript_tool` (getComputedStyle on each asserted
// selector), then writes them as JSON. THIS script just compares that JSON to the
// design tokens/assertions and writes the verdict. No browser here at all — pure comparison.
//
// Usage:
//   node assert-styles.mjs --assertions <03-design-spec/assertions.json> \
//        --clone-styles <clone-styles.json> --out <metrics.json> \
//        [--interaction-map <01-recon/interaction-map.json>] \
//        [--clone-routes <05-build/clone-route-manifest.json>]
//
//   assertions.json   : [{ "selector": "...", "prop": "...", "expected": "..." }]
//   clone-styles.json : { "<selector>": { "<prop>": "<actual computed value>" } }
//                       (produced by the agent via javascript_tool getComputedStyle)
//   interaction-map.json     : recon BFS-crawl output (route coverage source of truth)
//   clone-route-manifest.json: routes the built clone actually serves (Stage 5 emits it)
//
// PASS = style failed === 0 AND (no coverage gate, OR 0 missing routes).
// Exit codes: 0 pass · 1 style-only fail · 4 coverage-only fail · 3 both fail · 2 bad args/IO.

import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const assertionsPath = args.assertions;
const clonePath = args["clone-styles"];
const outPath = args.out;
if (!assertionsPath || !clonePath) {
  console.error("usage: assert-styles.mjs --assertions <a.json> --clone-styles <c.json> [--out <metrics.json>]");
  process.exit(2);
}

let assertions = [], clone = {};
try { assertions = JSON.parse(fs.readFileSync(assertionsPath)); } catch (e) { console.error("can't read assertions:", e.message); process.exit(2); }
try { clone = JSON.parse(fs.readFileSync(clonePath)); } catch (e) { console.error("can't read clone-styles:", e.message); process.exit(2); }

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const numeric = (s) => { const m = String(s).match(/-?\d*\.?\d+/); return m ? parseFloat(m[0]) : NaN; };

const failures = [];
let passed = 0;
for (const a of assertions) {
  const actual = (clone[a.selector] || {})[a.prop];
  const exp = a.expected;
  let ok;
  const en = numeric(exp), an = numeric(actual);
  if (!isNaN(en) && !isNaN(an) && /px|em|rem|%|^\s*-?\d/.test(String(exp))) {
    ok = Math.abs(en - an) <= (String(exp).includes("em") ? 0.01 : 1);
  } else {
    ok = norm(exp) === norm(actual);
  }
  if (ok) passed++; else failures.push({ selector: a.selector, prop: a.prop, expected: exp, actual: actual ?? null });
}

const block = { total: assertions.length, passed, failed: failures.length, failures };

// ---------------------------------------------------------------------------
// Coverage gate (opt-in) — every route discovered during recon must have a
// corresponding route/view in the clone. Driven by:
//   --interaction-map  01-recon/interaction-map.json   (recon BFS crawl output)
//   --clone-routes     05-build/clone-route-manifest.json (emitted by Stage 5)
// If --interaction-map is omitted, this gate is skipped (style-only run).
//
// interaction-map.json is tolerated in either shape:
//   { "views": [ { "route": "/x" }, ... ] }            (preferred)
//   [ { "route": "/x", ... }, ... ]                    (flat array of route objs)
// clone-route-manifest.json: { "routes": ["/x", "/y", ...] } or a flat string[].
// ---------------------------------------------------------------------------
const reconMapPath = args["interaction-map"];
const cloneRoutesPath = args["clone-routes"];
let coverage = null;

if (reconMapPath) {
  let reconMap;
  try { reconMap = JSON.parse(fs.readFileSync(reconMapPath)); }
  catch (e) { console.error("can't read interaction-map:", e.message); process.exit(2); }

  const reconViews = Array.isArray(reconMap) ? reconMap : (reconMap.views || []);
  const reconRoutes = new Set(
    reconViews.map(v => (typeof v === "string" ? v : v.route)).filter(Boolean)
  );

  let cloneRouteList = [];
  if (cloneRoutesPath) {
    try {
      const cm = JSON.parse(fs.readFileSync(cloneRoutesPath));
      cloneRouteList = Array.isArray(cm) ? cm : (cm.routes || []);
    } catch (e) { console.error("can't read clone-routes manifest:", e.message); process.exit(2); }
  }
  const cloneRoutes = new Set(cloneRouteList.filter(Boolean));

  const missing = [...reconRoutes].filter(r => !cloneRoutes.has(r));
  coverage = {
    recon_routes: reconRoutes.size,
    clone_routes: cloneRoutes.size,
    missing_count: missing.length,
    missing,
  };

  if (missing.length > 0) {
    console.error(`COVERAGE FAIL — ${missing.length} route(s) from recon not found in clone:`);
    missing.forEach(r => console.error(`  ✗ ${r}`));
  } else {
    console.log(`coverage: ${reconRoutes.size}/${reconRoutes.size} recon routes present in clone`);
  }
}

if (outPath) {
  let metrics = {};
  if (fs.existsSync(outPath)) { try { metrics = JSON.parse(fs.readFileSync(outPath)); } catch {} }
  metrics.style_assertions = block;
  if (coverage) metrics.coverage = coverage;
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
}
console.log(`style assertions: ${passed}/${assertions.length} passed, ${failures.length} failed`);

const styleFail = failures.length > 0;
const coverageFail = !!coverage && coverage.missing_count > 0;
process.exit(styleFail || coverageFail ? (styleFail && coverageFail ? 3 : (coverageFail ? 4 : 1)) : 0);

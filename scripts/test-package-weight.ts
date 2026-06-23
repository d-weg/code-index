#!/usr/bin/env -S npx tsx
// Unit tests for the pure package-weighting logic (no index / no embedder needed).
// Run: npx tsx scripts/test-package-weight.ts

import assert from "node:assert/strict";
import { tokenize } from "../src/bm25.js";
import { computePackageWeights, inferRole } from "../src/package-weight.js";

const PKGS = [
  { name: "backend", dir: "apps/backend" },
  { name: "frontend", dir: "apps/frontend" },
  { name: "mobile", dir: "apps/mobile" },
  { name: "@scope/shared", dir: "packages/shared" },
];

let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`  ok ${name}`);
};

console.log("package-weight:");

test("role inference from dependencies (the strong signal)", () => {
  // Names are deliberately uninformative — role comes from deps.
  assert.equal(inferRole({ name: "a", dir: "x", deps: ["elysia", "drizzle-orm", "@aws-sdk/client-s3"] }), "backend");
  assert.equal(inferRole({ name: "b", dir: "y", deps: ["next", "react-dom"] }), "frontend");
  assert.equal(inferRole({ name: "c", dir: "z", deps: ["expo", "react-native", "react-dom"] }), "mobile"); // RN wins over react-dom
  assert.equal(inferRole({ name: "d", dir: "w", deps: ["typescript"] }), "unknown"); // no fingerprint, no name hint
});

test("tsconfig hints when deps are inconclusive", () => {
  assert.equal(inferRole({ name: "svc", dir: "p", deps: ["lodash"], tsTypes: ["bun-types"] }), "backend");
  assert.equal(inferRole({ name: "ui", dir: "p", deps: ["lodash"], tsLib: ["dom", "esnext"] }), "frontend");
});

test("name/dir fallback when no deps/tsconfig", () => {
  assert.equal(inferRole({ name: "backend", dir: "apps/backend" }), "backend");
  assert.equal(inferRole({ name: "mobile", dir: "apps/mobile" }), "mobile");
  assert.equal(inferRole({ name: "@scope/shared", dir: "packages/shared" }), "shared");
});

test("precomputed role on the package is used as-is", () => {
  const { debug } = computePackageWeights({
    packages: [{ name: "weird-name", dir: "x", role: "backend" }],
    queryTokens: tokenize("transaction schema route"),
    config: {},
  });
  assert.equal(debug.roles["weird-name"], "backend");
});

test("no signal ⇒ all weights 1.0", () => {
  const { weight } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("rename a variable in some file"),
    config: {},
  });
  for (const p of PKGS) assert.equal(weight[p.name], 1.0);
});

test("backend-typed query boosts only backend", () => {
  const { weight, debug } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("wrap the route in a db transaction and update the schema atomically"),
    config: { queryLayerWeighting: { enabled: true, boost: 0.6 } },
  });
  assert.ok(debug.firedLayers.includes("backend"), "backend layer should fire");
  assert.ok(weight.backend > 1.0, "backend boosted");
  assert.equal(weight.mobile, 1.0, "mobile untouched");
  assert.ok(weight.backend >= weight.mobile);
});

test("mobile-typed query boosts only mobile (no backend regression)", () => {
  const { weight } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("render the screen layout component and handle the tap gesture"),
    config: { queryLayerWeighting: { enabled: true, boost: 0.6 } },
  });
  assert.ok(weight.mobile > 1.0, "mobile boosted");
  assert.equal(weight.backend, 1.0, "backend not penalised");
});

test("static packageWeights (the simplest viable lever) apply by name", () => {
  const { weight } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("nothing layer-specific here"),
    config: { packageWeights: { backend: 1.3, mobile: 0.9 } },
  });
  assert.equal(weight.backend, 1.3);
  assert.equal(weight.mobile, 0.9);
  assert.equal(weight.frontend, 1.0);
});

test("static weights can be keyed by role", () => {
  const { weight } = computePackageWeights({
    packages: PKGS,
    queryTokens: [],
    config: { packageWeights: { backend: 1.5 } }, // matches role 'backend' → pkg 'backend'
  });
  assert.equal(weight.backend, 1.5);
});

test("static × query-conditioned compose multiplicatively", () => {
  const { weight } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("db transaction schema migration atomic route"),
    config: { packageWeights: { backend: 1.2 }, queryLayerWeighting: { enabled: true, boost: 0.5 } },
  });
  // backend role fires as the dominant layer ⇒ ×(1+0.5)=×1.5 on top of static 1.2 ⇒ 1.8.
  assert.ok(Math.abs(weight.backend - 1.8) < 1e-9, `expected 1.8, got ${weight.backend}`);
});

test("disabling query weighting leaves only static", () => {
  const { weight, debug } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("db transaction schema route"),
    config: { packageWeights: { backend: 1.2 }, queryLayerWeighting: { enabled: false } },
  });
  assert.equal(weight.backend, 1.2);
  assert.deepEqual(debug.firedLayers, []);
});

test("prefix matching: atomically→atomic, presigned→presign", () => {
  const { debug } = computePackageWeights({
    packages: PKGS,
    queryTokens: tokenize("do it atomically with a presigned url"),
    config: {},
  });
  assert.ok(debug.layerScores.backend >= 2, "atomic + presign should both hit");
});

console.log(`\n${n} passed\n`);

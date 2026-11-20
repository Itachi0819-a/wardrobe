const test = require("node:test");
const assert = require("node:assert/strict");
const data = require("../data.json");
const Logic = require("../logic.js");

const KEPT = "已确认仍在、可穿用。";

function item(partial) {
  return Object.assign({
    id: "x",
    name: "样例",
    brand: "",
    category: "top",
    color: "white",
    style: "casual",
    warmth: "",
    status: "可穿",
    sources: [],
    lookalike: false,
    low_priority: false,
    image: null,
    image_kind: "",
    note: KEPT,
    retire_reason: ""
  }, partial);
}

test("core notes are cited one by one and model checks are not ownership", () => {
  const report = data.core_items.map((id) => {
    const found = data.items.find((entry) => entry.id === id);
    const evidence = Logic.ownershipEvidence(data, found);
    return { id, proven: evidence.proven, kind: evidence.kind };
  });
  const proven = report.filter((entry) => entry.proven).map((entry) => entry.id).sort();
  assert.deepEqual(proven, [
    "owned-dior-club-m1u",
    "owned-khaki-straight-2026",
    "owned-lv-white-sneaker",
    "owned-white-knit-2026"
  ]);
  ["printed-blue-outer-current", "emporio-armani-3d1p68-ecru-altered", "emporio-armani-6r1mf1-white-jacket"].forEach((id) => {
    const found = report.find((entry) => entry.id === id);
    assert.equal(found.proven, false);
    assert.equal(found.kind, "model");
  });
  const gucci = data.items.find((entry) => entry.id === "jd-10035274011403");
  const gucciEvidence = Logic.ownershipEvidence(data, gucci);
  assert.equal(gucciEvidence.proven, false);
  assert.equal(gucciEvidence.kind, "identity");
  const bought = data.items.find((entry) => /已购可穿/.test(entry.note || ""));
  assert.equal(Logic.ownershipEvidence(data, bought).kind, "bought");
  const bare = data.items.find((entry) => entry.status === "可穿" && !(entry.note || "").trim());
  assert.equal(Logic.ownershipEvidence(data, bare).kind, "status");
});

test("catalog ids are unchanged from the public file shape and not reduced toward a 147-item memory", () => {
  const ids = data.items.map((entry) => entry.id);
  assert.equal(ids.length, 143);
  assert.equal(new Set(ids).size, 143);
  assert.equal(data.counts.total, 143);
  assert.equal(ids.includes("jd-10096351305311"), true);
  assert.equal(ids.includes("jd-10072290053975"), true);
  assert.equal(data.items.some((entry) => /SolarStorm|范思哲白色胶印/.test(entry.name + (entry.note || ""))), false);
});

test("local confirmation can add and revoke outfit evidence without changing public status", () => {
  const pub = [
    item({ id: "shirt", name: "白色长袖衬衫", warmth: "medium", note: "" }),
    item({ id: "pant", name: "深灰加绒长裤", category: "bottom", note: "" }),
    item({ id: "coat", name: "鹅绒羽绒服", category: "outerwear", note: "" }),
    item({ id: "shoe", name: "白色运动鞋", category: "shoes", note: KEPT })
  ];
  const before = structuredClone(pub[0]);
  const local = Logic.emptyLocal();
  ["shirt", "pant", "coat"].forEach((id) => { local.overrides[id] = { retain: "yes" }; });
  const merged = Logic.mergeCatalog(pub, local, data.statuses.map((row) => row.id));
  assert.equal(pub[0].status, before.status);
  assert.equal(pub[0].note, "");
  const cold = Logic.recommendOutfits(data, merged, { occasion: "daily", tempText: "5" });
  assert.equal(cold.outfits.length, 1);
  assert.equal(cold.outfits[0].items.some((entry) => /羽绒/.test(entry.name)), true);
  assert.equal(cold.outfits[0].items.some((entry) => entry.id === "shirt"), true);

  const knit = item({ id: "knit", name: "白色短袖针织", warmth: "light" });
  const withKnit = merged.concat([knit]);
  const rejected = Logic.recommendOutfits(data, withKnit, { occasion: "work", tempText: "5" });
  assert.equal(rejected.outfits.some((outfit) => outfit.items.some((entry) => entry.id === "knit")), false);

  local.overrides.shirt.retain = "no";
  const revoked = Logic.mergeCatalog(pub, local, data.statuses.map((row) => row.id));
  const after = Logic.recommendOutfits(data, revoked, { occasion: "daily", tempText: "5" });
  assert.equal(after.outfits.length, 0);
  assert.equal(pub[0].status, "可穿");
});

test("empty import, duplicate ids, corrupt cache, and restore do not drop data", () => {
  const empty = Logic.previewMerge(data, data.items, Logic.emptyLocal(), JSON.stringify({ items: [] }));
  assert.equal(empty.preview.added.length, 0);
  assert.equal(empty.preview.keptDespiteOmission, 143);
  const still = Logic.mergeCatalog(data.items, empty.preview.safeNext, data.statuses.map((row) => row.id));
  assert.deepEqual(still.map((entry) => entry.id), data.items.map((entry) => entry.id));

  const dup = Logic.previewMerge(data, [], Logic.emptyLocal(), JSON.stringify({
    items: [
      item({ id: "same", name: "第一件白衬衫", note: "袖口完好" }),
      item({ id: "same", name: "第二件不该覆盖", note: "另一段备注" })
    ]
  }));
  assert.equal(dup.preview.added.length, 1);
  assert.equal(dup.preview.added[0].name, "第一件白衬衫");
  assert.equal(dup.preview.notices.some((notice) => notice.action === "未采用" && notice.id === "same"), true);
  const dupMerged = Logic.mergeCatalog([], dup.preview.safeNext, data.statuses.map((row) => row.id));
  assert.equal(dupMerged.length, 1);
  assert.match(dupMerged[0].note, /袖口完好/);

  const writes = [];
  const oddShape = {
    getItem() {
      return JSON.stringify({ version: 1, overrides: null, extraItems: [{ id: "a", name: "甲" }, { id: "a", name: "乙" }, { id: "bad id" }] });
    },
    setItem(key, value) { writes.push([key, value]); }
  };
  const read = Logic.readLocal(oddShape);
  assert.equal(read.ok, true);
  assert.equal(read.state.extraItems.length, 1);
  assert.equal(read.state.extraItems[0].name, "甲");
  assert.deepEqual(writes, []);

  const poison = {
    getItem() {
      return JSON.stringify({ version: 1, overrides: { __proto__: { status: "可穿" }, "ok-id": { retain: "yes" } }, extraItems: [] });
    },
    setItem() { throw new Error("should not write"); }
  };
  const safe = Logic.readLocal(poison);
  assert.equal(safe.ok, true);
  assert.equal(Object.prototype.status, undefined);
  assert.equal(safe.state.overrides["ok-id"].retain, "yes");
  assert.equal(safe.state.overrides.__proto__, undefined);

  const restored = Logic.mergeCatalog(data.items, Logic.emptyLocal(), data.statuses.map((row) => row.id));
  assert.equal(restored.length, data.items.length);
  assert.equal(restored[0].status, data.items[0].status);
});

test("local import keeps legitimate notes and images, and previews every discard", () => {
  const incoming = {
    items: [{
      id: "local-tee",
      name: "本机白T<script>alert(1)</script>",
      category: "top",
      status: "可穿",
      image: "https://shop.example/tee.jpg",
      note: "袖口完好，联系13800138000，剩下还要留着。",
      image_kind: "本机外链"
    }, {
      id: "script-pic",
      name: "脚本图",
      category: "top",
      status: "可穿",
      image: "javascript:alert(1)",
      note: "只有这句备注"
    }]
  };
  const preview = Logic.previewMerge(data, data.items, Logic.emptyLocal(), JSON.stringify(incoming));
  assert.equal(preview.ok, true);
  const tee = preview.preview.safeNext.extraItems.find((entry) => entry.id === "local-tee");
  assert.equal(tee.image, "https://shop.example/tee.jpg");
  assert.equal(tee.image_scope, "local-remote");
  assert.match(tee.note, /袖口完好/);
  assert.match(tee.note, /剩下还要留着/);
  assert.equal(tee.note.includes("13800138000"), false);
  assert.equal(tee.name.includes("<script>"), false);
  assert.equal(tee.name.includes("本机白T"), true);
  const script = preview.preview.safeNext.extraItems.find((entry) => entry.id === "script-pic");
  assert.equal(script.image, null);
  assert.match(script.note, /只有这句备注/);
  const reasons = preview.preview.notices.map((notice) => notice.id + notice.action + notice.reason).join("\n");
  assert.match(reasons, /打码/);
  assert.match(reasons, /去掉标签/);
  assert.match(reasons, /脚本/);
  assert.match(reasons, /留在本机/);
  const merged = Logic.mergeCatalog(data.items, preview.preview.safeNext, data.statuses.map((row) => row.id));
  assert.equal(merged.length, data.items.length + 2);
  assert.equal(merged.some((entry) => String(entry.image || "").startsWith("javascript:")), false);
});

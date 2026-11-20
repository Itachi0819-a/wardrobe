const test = require("node:test");
const assert = require("node:assert/strict");
const data = require("../data.json");
const Logic = require("../logic.js");

const KEEP_SHORTS = "jd-10096351305311";
const ADIDAS_SHORTS = "jd-10072290053975";
const WOMENS = "tb-2019-11-11-nike-ci8938-womens";
const UNDERWEAR = "jd-100039062203";
const HELD = ["jd-39406521801", "jd-8999951"];

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
    sources: ["京东"],
    lookalike: false,
    low_priority: false,
    image: null,
    image_kind: "",
    note: "",
    retire_reason: ""
  }, partial);
}

function outfitItems(result) {
  return result.outfits.flatMap((outfit) => outfit.items);
}

test("public counts match the items and the historical thrown pieces stay absent", () => {
  const counts = Logic.countsOf(data.items);
  assert.deepEqual(counts, data.counts);
  assert.equal(Logic.countsDiffer(counts, data.counts), false);
  assert.equal(data.items.some((entry) => /SolarStorm|范思哲白色胶印/.test(entry.name)), false);
  assert.equal(data.items.some((entry) => entry.id === "cand-metal-aviator" && entry.image == null), true);
  assert.equal(data.items.find((entry) => entry.id === KEEP_SHORTS).status, "已淘汰/不常穿");
  assert.equal(data.items.find((entry) => entry.id === ADIDAS_SHORTS).low_priority, true);
  assert.equal(Logic.initialTempText(data), "");
  data.items.forEach((entry) => {
    if (entry.image != null) assert.equal(Logic.safeImage(entry.image), entry.image);
    assert.equal(/https?:|data:image/i.test(JSON.stringify(entry.image)), false);
  });
});

test("dates are not model codes, and only known retired twins are held back", () => {
  assert.deepEqual(Logic.modelKeys({ name: "外套", note: "【已核实 2026-10-28】" }), []);
  const result = Logic.recommendOutfits(data, data.items, { occasion: "daily", tempText: "" });
  assert.deepEqual(result.heldBack.map((entry) => entry.id).sort(), HELD.slice().sort());
  data.core_items.forEach((id) => {
    assert.equal(result.heldBack.some((entry) => entry.id === id), false);
  });
});

test("outfits stay inside wearable, non-loafer, non-deep-coffee clothes", () => {
  const occasions = ["daily", "work", "date", "formal", "sport"];
  const temps = ["", "5", "18", "30"];
  occasions.forEach((occasion) => {
    temps.forEach((tempText) => {
      const result = Logic.recommendOutfits(data, data.items, { occasion, tempText, withAccessory: false });
      assert.ok(result.outfits.length <= 2, occasion + " " + tempText);
      result.outfits.forEach((outfit) => {
        outfit.items.forEach((entry) => assert.equal(Logic.ownershipEvidence(data, entry).proven, true));
      });
      if (tempText === "5") {
        assert.equal(result.outfits.length, 0, occasion);
        assert.match(result.general.join("\n"), /证据不足/);
      }
      if (result.outfits[0]) assert.equal(result.outfits[0].role, "primary");
      if (result.outfits[1]) {
        assert.equal(result.outfits[1].role, "backup");
        const primaryTop = result.outfits[0].items.find((entry) => entry.category === "top" || entry.category === "dress");
        const backupTop = result.outfits[1].items.find((entry) => entry.category === "top" || entry.category === "dress");
        assert.notEqual(primaryTop.id, backupTop.id);
      }
      const used = outfitItems(result);
      used.forEach((entry) => {
        assert.equal(Logic.eligible(data, entry), true);
        assert.equal(entry.category === "accessory" || entry.category === "bag", false);
        assert.equal(Logic.safeImage(entry.image) === entry.image || entry.image == null, true);
      });
      const ids = used.map((entry) => entry.id);
      assert.equal(ids.includes(KEEP_SHORTS), false);
      assert.equal(ids.includes(ADIDAS_SHORTS), false);
      assert.equal(ids.includes(WOMENS), false);
      assert.equal(ids.includes(UNDERWEAR), false);
      HELD.forEach((id) => assert.equal(ids.includes(id), false));
      if (tempText === "" || tempText === "30") {
        assert.equal(used.some((entry) => entry.category === "outerwear"), false);
      }
      if (tempText === "30") {
        assert.equal(used.some((entry) => /羽绒|加绒/.test(entry.name)), false);
      }
    });
  });
});

test("unknown temperature does not judge warmth, and cold work is not assembled", () => {
  const daily = Logic.recommendOutfits(data, data.items, { occasion: "daily", tempText: "" });
  assert.equal(daily.warmthJudged, false);
  assert.match(daily.general.join("\n"), /温度未知/);
  assert.match(daily.general.join("\n"), /不作保暖判断/);
  assert.equal(daily.outfits.length, 1);
  assert.equal(daily.outfits[0].title, "已确认单品组合");
  assert.deepEqual(daily.outfits[0].items.map((entry) => entry.id), ["owned-white-knit-2026", "owned-khaki-straight-2026", "owned-lv-white-sneaker"]);
  assert.equal(daily.outfits[0].items.some((entry) => entry.category === "outerwear"), false);

  const coldWork = Logic.recommendOutfits(data, data.items, { occasion: "work", tempText: "5" });
  assert.equal(coldWork.outfits.length, 0);
  assert.match(coldWork.general.join("\n"), /证据不足/);
  assert.match(coldWork.gaps.join("\n"), /短袖不能靠外层羽绒/);
  assert.equal(JSON.stringify(coldWork.outfits).includes("波司登"), false);
  assert.equal(JSON.stringify(coldWork.outfits).includes("owned-white-knit-2026"), false);

  ["formal", "sport"].forEach((occasion) => {
    const result = Logic.recommendOutfits(data, data.items, { occasion, tempText: "" });
    assert.equal(result.outfits.length, 0, occasion);
    assert.match(result.general.join("\n"), /证据不足/);
  });
});

test("low priority, loafers, deep coffee, and accessory safety use fixtures", () => {
  const kept = "已确认仍在、可穿用。";
  const onlyShorts = [
    item({ id: "tee", name: "运动T恤", category: "top", style: "sport", note: kept }),
    item({ id: "adidas", name: "adidas IC2453 运动短裤", category: "bottom", low_priority: true, note: kept }),
    item({ id: "shoe", name: "跑鞋", category: "shoes", style: "sport", note: kept })
  ];
  const forced = Logic.recommendOutfits(data, onlyShorts, { occasion: "sport", tempText: "28" });
  assert.equal(forced.outfits[0].items.some((entry) => entry.id === "adidas"), true);
  assert.match(forced.outfits[0].warnings.join(" "), /不优先/);

  const withChoice = onlyShorts.concat([item({ id: "pant", name: "运动长裤", category: "bottom", style: "sport", note: kept })]);
  const avoided = Logic.recommendOutfits(data, withChoice, { occasion: "sport", tempText: "28" });
  assert.equal(outfitItems(avoided).some((entry) => entry.id === "adidas"), false);

  const mixed = [
    item({ id: "tee", name: "白色T恤", category: "top", note: kept }),
    item({ id: "coffee", name: "深咖衬衫", category: "top", note: kept }),
    item({ id: "khaki", name: "卡其直筒裤", category: "bottom", color: "beige", note: kept }),
    item({ id: "loafer", name: "黑色乐福鞋", category: "shoes", note: kept }),
    item({ id: "sneaker", name: "白色运动鞋", category: "shoes", note: kept }),
    item({ id: "brown", name: "棕色夹克", category: "outerwear", color: "brown", note: kept }),
    item({ id: "glasses", name: "近视光学眼镜", category: "accessory", note: kept }),
    item({ id: "hat", name: "滑雪帽", category: "accessory", note: kept })
  ];
  const daily = Logic.recommendOutfits(data, mixed, { occasion: "daily", tempText: "24", withAccessory: true });
  const names = outfitItems(daily).map((entry) => entry.name).join(" ");
  assert.equal(/乐福|深咖|近视|滑雪|夹克/.test(names), false);
  assert.match(names, /卡其/);
  assert.match(names, /白色T恤/);
  const cool = Logic.recommendOutfits(data, mixed, { occasion: "daily", tempText: "16" });
  assert.equal(cool.outfits.length, 0);
});

test("retired and record items stay out of the main filter and search can use category labels", () => {
  const main = Logic.filterItems(data, data.items, { statusFilter: "all", category: "all", source: "all" });
  assert.equal(main.some((entry) => entry.status === "已淘汰/不常穿"), false);
  assert.equal(main.some((entry) => entry.id === KEEP_SHORTS), false);
  const culled = Logic.filterItems(data, data.items, { culledOnly: true, category: "all", source: "all" });
  assert.equal(culled.length, data.counts.retired);
  assert.equal(culled.every((entry) => entry.status === "已淘汰/不常穿"), true);
  const wearable = Logic.filterItems(data, data.items, { statusFilter: "wearable" });
  assert.equal(wearable.every((entry) => entry.status === "可穿"), true);
  const accessories = data.items.filter((entry) => entry.category === "accessory" && entry.status !== "已淘汰/不常穿");
  const hits = Logic.filterItems(data, data.items, { query: "配饰", statusFilter: "all" });
  accessories.forEach((entry) => assert.equal(hits.some((hit) => hit.id === entry.id), true));
  const missing = Logic.filterItems(data, data.items, { query: "金属框飞行员", statusFilter: "all" });
  assert.deepEqual(missing.map((entry) => entry.id), ["cand-metal-aviator"]);
});

test("import merge keeps omitted items, drops unsafe images, and can apply status only when asked", () => {
  const first = data.items[0];
  const second = data.items[1];
  const before = structuredClone(first);
  const incoming = {
    items: [
      Object.assign({}, first, { status: "已淘汰/不常穿", image: "https://evil.example/a.jpg", note: "联系13800138000" }),
      { id: "new-shirt", name: "新加的白衬衫", category: "top", status: "可穿", image: "images/new-shirt.webp", sources: ["京东"] },
      { id: "bad-cat", name: "坏分类", category: "cape", status: "可穿" },
      { id: "photo", name: "data:image/png;base64,aaaa", category: "top", status: "可穿" }
    ]
  };
  const preview = Logic.previewMerge(data, [first, second], Logic.emptyLocal(), JSON.stringify(incoming));
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.added.length, 1);
  assert.equal(preview.preview.keptDespiteOmission, 1);
  assert.equal(preview.preview.rejected.length, 2);
  assert.equal(preview.preview.notices.some((notice) => notice.id === first.id && notice.field === "image" && notice.action === "未覆盖"), true);
  assert.deepEqual(first, before);

  const safeItems = Logic.mergeCatalog([first, second], preview.preview.safeNext, data.statuses.map((row) => row.id));
  assert.deepEqual(safeItems.map((entry) => entry.id), [first.id, second.id, "new-shirt"]);
  assert.equal(safeItems[0].status, first.status);
  assert.equal(safeItems[0].image, first.image);
  assert.equal(/13800138000|evil\.example|data:image/.test(JSON.stringify(safeItems)), false);

  const statusItems = Logic.mergeCatalog([first, second], preview.preview.statusNext, data.statuses.map((row) => row.id));
  assert.equal(statusItems[0].status, "已淘汰/不常穿");
  assert.equal(first.status, before.status);
  assert.equal(statusItems.some((entry) => entry.id === second.id), true);

  const full = Logic.previewMerge(data, data.items, Logic.emptyLocal(), JSON.stringify(data));
  const merged = Logic.mergeCatalog(data.items, full.preview.safeNext, data.statuses.map((row) => row.id));
  assert.equal(full.preview.added.length, 0);
  assert.equal(merged.length, data.items.length);
  merged.forEach((entry, index) => {
    assert.equal(entry.id, data.items[index].id);
    assert.equal(entry.status, data.items[index].status);
    assert.equal(entry.note, data.items[index].note);
    assert.equal(entry.image, data.items[index].image);
  });
});

test("local status override does not mutate public items or enter outfits after retirement", () => {
  const pub = [
    item({ id: "tee", name: "白色T恤" }),
    item({ id: "other", name: "灰色T恤" }),
    item({ id: "pant", name: "黑色长裤", category: "bottom" })
  ];
  const local = Logic.emptyLocal();
  local.overrides.tee = { status: "已淘汰/不常穿", retire_reason: "仅在本机标为已淘汰/不常穿，未写入公开清单。" };
  const merged = Logic.mergeCatalog(pub, local, data.statuses.map((row) => row.id));
  assert.equal(pub[0].status, "可穿");
  assert.equal(merged[0].status, "已淘汰/不常穿");
  const result = Logic.recommendOutfits(data, merged, { occasion: "daily", tempText: "" });
  assert.equal(outfitItems(result).some((entry) => entry.id === "tee"), false);
  assert.equal(Logic.mergeCatalog(pub, Logic.emptyLocal(), data.statuses.map((row) => row.id))[0].status, "可穿");
});

test("storage failures are reported and corrupt cache is not overwritten", () => {
  const writes = [];
  const quota = {
    getItem() { return null; },
    setItem() { throw new Error("quota"); }
  };
  const saved = Logic.writeLocal(quota, Logic.emptyLocal());
  assert.equal(saved.ok, false);
  assert.match(saved.error, /保存失败/);

  const corrupt = {
    getItem() { return "{"; },
    setItem(key, value) { writes.push([key, value]); }
  };
  const read = Logic.readLocal(corrupt);
  assert.equal(read.ok, false);
  assert.match(read.error, /读不出来/);
  assert.deepEqual(writes, []);
  assert.equal(Logic.localIsEmpty(read.state), true);

  const odd = {
    getItem() { return JSON.stringify({ version: 99, items: [] }); },
    setItem() { throw new Error("should not write"); }
  };
  const unknown = Logic.readLocal(odd);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有覆盖或清空/);
});

test("unsafe urls and oversized imports do not replace the wardrobe", () => {
  assert.equal(Logic.safeImage("https://example.com/a.jpg"), null);
  assert.equal(Logic.safeImage("data:image/png;base64,aaaa"), null);
  assert.equal(Logic.safeImage("images/../secret.webp"), null);
  assert.equal(Logic.safeImage("images/a.webp"), "images/a.webp");
  assert.equal(Logic.safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(Logic.safeHttpUrl("https://itachi0819-a.github.io/wardrobe/"), "https://itachi0819-a.github.io/wardrobe/");
  const huge = Logic.previewMerge(data, data.items, Logic.emptyLocal(), " ".repeat(2000001));
  assert.equal(huge.ok, false);
  assert.match(huge.error, /没有改动|停止导入/);
  const broken = Logic.previewMerge(data, data.items, Logic.emptyLocal(), "{");
  assert.equal(broken.ok, false);
});

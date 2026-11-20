(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WardrobeLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LOCAL_KEY = "wardrobe.local.v1";
  var FILL_KEYS = ["brand", "color", "style", "warmth", "image", "image_kind", "note", "sources"];
  var MAX_IMPORT_CHARS = 2000000;
  var MAX_EXTRA = 500;
  var POOL_CAP = 15;

  function emptyLocal() {
    return { version: 1, overrides: Object.create(null), extraItems: [] };
  }

  function labelOf(list, id, fallback) {
    var found = (list || []).find(function (row) { return row.id === id; });
    return found ? found.label : (fallback || id || "");
  }

  function tempConfig(data) {
    var temp = (data.scoring && data.scoring.temp) || {};
    return {
      cold: Number.isFinite(Number(temp.cold)) ? Number(temp.cold) : 12,
      cool: Number.isFinite(Number(temp.cool)) ? Number(temp.cool) : 20,
      hot: Number.isFinite(Number(temp.hot)) ? Number(temp.hot) : 26
    };
  }

  function parseTemp(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!text) return null;
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    var num = Number(text);
    return Number.isFinite(num) ? num : null;
  }

  function initialTempText(data) {
    var scoring = (data && data.scoring) || {};
    if (scoring.apply_default_temp !== true) return "";
    if (scoring.default_temp == null || scoring.default_temp === "") return "";
    return String(scoring.default_temp);
  }

  function blob(item) {
    return [item && item.name, item && item.brand, item && item.note, item && item.retire_reason].filter(Boolean).join(" ");
  }

  function classify(item) {
    var name = blob(item);
    var shortSleeve = /短袖/.test(name);
    return {
      heavy: /羽绒|棉服|皮草/.test(name),
      lined: /加绒/.test(name),
      shorts: /短裤/.test(name) && !/内裤/.test(name),
      shortSleeve: shortSleeve,
      longSleeve: /长袖/.test(name) && !shortSleeve,
      sunShell: /防晒衣|防晒服/.test(name),
      optical: /近视|光学眼镜/.test(name),
      winterHat: /滑雪|雷锋|护耳|棉帽/.test(name),
      sunGlass: /墨镜|太阳镜/.test(name) && !/近视|光学/.test(name),
      keep: /keep/i.test(name),
      dressShoe: /皮鞋/.test(name),
      baseLayer: /紧身/.test(name),
      running: /跑步鞋|跑鞋|adizero|run swift/i.test(name)
    };
  }

  function isLoafer(item) {
    return /乐福/.test(blob(item));
  }

  function isDeepCoffee(item) {
    return /深咖/.test(blob(item));
  }

  function statusAllowsOutfit(data, status) {
    var row = (data.statuses || []).find(function (entry) { return entry.id === status; });
    if (row && typeof row.in_outfit === "boolean") return row.in_outfit;
    return status === "可穿";
  }

  function eligible(data, item) {
    if (!item || !statusAllowsOutfit(data, item.status)) return false;
    if (isLoafer(item) || isDeepCoffee(item)) return false;
    return true;
  }

  function normName(value) {
    return String(value || "").replace(/\s+/g, "").toLowerCase();
  }

  function modelKeys(item) {
    var text = (item.name || "") + " " + (item.note || "");
    var found = text.match(/[A-Za-z0-9]{3,}(?:[-_][A-Za-z0-9]{2,})+/g) || [];
    var keys = [];
    found.forEach(function (token) {
      var upper = token.toUpperCase();
      if (!/[A-Z]/.test(upper)) return;
      if (/^\d{4}-\d{2}-\d{2}$/.test(upper)) return;
      if (keys.indexOf(upper) === -1) keys.push(upper);
    });
    return keys;
  }

  function duplicateIndex(items) {
    var byKey = new Map();
    function add(key, item) {
      if (!key) return;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }
    (items || []).forEach(function (item) {
      add("name:" + normName(item.name), item);
      modelKeys(item).forEach(function (code) { add("code:" + code, item); });
    });
    var info = new Map();
    (items || []).forEach(function (item) {
      var related = new Map();
      modelKeys(item).forEach(function (code) {
        (byKey.get("code:" + code) || []).forEach(function (other) {
          if (other.id !== item.id) related.set(other.id, other);
        });
      });
      var nameKey = normName(item.name);
      if (nameKey) {
        (byKey.get("name:" + nameKey) || []).forEach(function (other) {
          if (other.id !== item.id) related.set(other.id, other);
        });
      }
      var others = Array.from(related.values());
      if (!others.length) return;
      info.set(item.id, {
        others: others,
        retiredTwin: others.some(function (other) { return other.status === "已淘汰/不常穿"; }),
        keys: modelKeys(item)
      });
    });
    return info;
  }

  function ownershipEvidence(data, item) {
    var note = (item && item.note) || "";
    var core = (data && data.core_items) || [];
    var inCore = !!(item && core.indexOf(item.id) !== -1);
    if (item && item._retainLocal === "no") {
      return { proven: false, kind: "revoked", reason: "你在本机撤销了保留确认，自动搭配不用它。公开清单没有改。" };
    }
    if (item && item._retainLocal === "yes") {
      return { proven: true, kind: "local", reason: "你在本机确认现在仍保留、可穿。公开清单里的状态和备注都没有改。" };
    }
    if (/已确认仍在/.test(note) && /可穿/.test(note)) {
      return { proven: true, kind: "note", reason: "备注写明「已确认仍在、可穿用」。这是保留证据，不是款号核实。" };
    }
    var reason = "";
    var kind = "status";
    if (/已核实/.test(note)) {
      kind = "model";
      reason = "备注核实的是款式、款号、水洗或购买关联，没有写明现在仍保留可穿。";
    } else if (/已确认/.test(note)) {
      kind = "identity";
      reason = "备注里的「已确认」没有同时写「仍在、可穿」，不能当成现在还留着。";
    } else if (/已购可穿/.test(note)) {
      kind = "bought";
      reason = "「已购可穿」只说明买过并曾当作可穿，不是新的保留证明。";
    } else if (item && item.status === "可穿") {
      kind = "status";
      reason = "状态是可穿，但没有写明现在仍保留。购买记录不能当成已经证实。";
    } else {
      kind = "other";
      reason = "没有进入自动搭配的保留证据。";
    }
    if (inCore) reason += "它列在核心清单里，但名单不能代替这句保留原话。";
    return { proven: false, kind: kind, reason: reason };
  }

  function confirmationTier(data, item) {
    var evidence = ownershipEvidence(data, item);
    if (evidence.proven && evidence.kind === "note") return 1;
    if (evidence.kind === "bought") return 2;
    return 3;
  }

  function tempBand(temp, cfg) {
    if (temp == null) return "unknown";
    if (temp <= cfg.cold) return "cold";
    if (temp < cfg.cool) return "cool";
    if (temp < cfg.hot) return "mild";
    return "hot";
  }

  function lightTop(item) {
    var g = classify(item);
    return (g.shortSleeve || /T恤|Polo|POLO|polo/.test(item.name || "")) && !g.longSleeve;
  }

  function warmthOk(item, temp, cfg) {
    if (temp == null) return { ok: true, judged: false, reason: "温度未知，不判断厚薄。" };
    var g = classify(item);
    var field = item.warmth || "";
    var band = tempBand(temp, cfg);
    if (["shoes", "accessory", "bag"].indexOf(item.category) !== -1) {
      return { ok: true, judged: true, reason: "鞋和配饰不代替衣服的保暖层。" };
    }
    if (band === "cold") {
      if (item.category === "top" || item.category === "dress") {
        if (lightTop(item)) return { ok: false, judged: true, reason: "短袖、Polo 或 T 恤不能作为 " + temp + "℃ 的上衣，加羽绒也不把它算成保暖层。" };
        if (g.longSleeve || field === "warm") return { ok: true, judged: true, reason: "有长袖或保暖字段。" };
        return { ok: false, judged: true, reason: "没有长袖或保暖证据，不能用于 " + temp + "℃。" };
      }
      if (item.category === "bottom") {
        if (g.shorts) return { ok: false, judged: true, reason: "短裤不用于低温。" };
        if (g.lined || field === "warm" || field === "medium") return { ok: true, judged: true, reason: "有加绒、中等或保暖厚薄。" };
        return { ok: false, judged: true, reason: "下装没有保暖证据。偏薄或没填厚薄，都不能用于 " + temp + "℃。" };
      }
      if (item.category === "outerwear") {
        if (g.sunShell) return { ok: false, judged: true, reason: "防晒衣不是防寒层。" };
        if (g.heavy || field === "warm") return { ok: true, judged: true, reason: "名称是羽绒、棉服、皮草，或厚薄为保暖。" };
        return { ok: false, judged: true, reason: "不是明确的防寒外套。" };
      }
    }
    if (band === "cool") {
      if (item.category === "top" || item.category === "dress") {
        if (lightTop(item)) return { ok: false, judged: true, reason: temp + "℃ 低于 " + cfg.cool + "℃，短袖不能单独当上衣。" };
        if (g.longSleeve || field === "medium" || field === "warm") return { ok: true, judged: true, reason: "有长袖或中等以上厚薄。" };
        return { ok: false, judged: true, reason: "厚薄证据不足，不在这个气温使用。" };
      }
      if (item.category === "bottom") {
        if (g.shorts || field === "light") return { ok: false, judged: true, reason: "短裤或清单写明偏薄的下装，不用于 " + temp + "℃。" };
        if (field === "medium" || field === "warm" || g.lined) return { ok: true, judged: true, reason: "有中等以上或加绒证据。" };
        return { ok: false, judged: true, reason: "没有厚薄证据，不在偏低气温里使用。" };
      }
      if (item.category === "outerwear") {
        if (g.heavy || field === "warm") return { ok: false, judged: true, reason: "羽绒服或保暖外套不自动加在这个气温。" };
        if (g.sunShell) return { ok: false, judged: true, reason: "防晒衣不当这个气温的外套。" };
        return { ok: true, judged: true, reason: "可以当作薄外套。" };
      }
    }
    if (band === "mild" || band === "hot") {
      if (g.heavy || g.lined || field === "warm" || (band === "hot" && field === "medium")) {
        return { ok: false, judged: true, reason: "羽绒、加绒或偏厚字段不用于 " + temp + "℃。" };
      }
      if (item.category === "outerwear") return { ok: false, judged: true, reason: temp + "℃ 不自动加外套。" };
      return { ok: true, judged: true, reason: "没有发现和 " + temp + "℃ 冲突的厚薄证据。" };
    }
    return { ok: false, judged: true, reason: "无法判断厚薄。" };
  }

  function occasionOk(item, occasion) {
    var g = classify(item);
    var name = (item.name || "") + (item.note || "");
    if (item.category === "shoes") {
      if (g.dressShoe && occasion !== "formal") return false;
      if (occasion === "sport") return g.running || /运动|跑/.test(item.name || "");
      if (occasion === "formal") return g.dressShoe;
      return true;
    }
    if (item.category === "top" || item.category === "dress") {
      if (occasion === "sport") return item.style === "sport" || /运动|速干/.test(item.name || "");
      if (occasion === "formal") return /长袖/.test(item.name || "") && /衬衫/.test(item.name || "");
      if (occasion === "work") return !/针织开襟|偏透/.test(name) && !g.baseLayer;
      return !g.baseLayer;
    }
    if (item.category === "bottom") {
      if (occasion === "sport") return item.style === "sport" || /运动|束脚|跑/.test(item.name || "");
      if (occasion === "formal") return /裤/.test(item.name || "") && !/短裤/.test(item.name || "");
      if (occasion === "work") return !g.shorts;
      return true;
    }
    if (item.category === "outerwear") return occasion !== "sport";
    return false;
  }

  function seasonalAdjustment(item, temp, cfg) {
    if (temp == null) return { delta: 0, inferred: false };
    var g = classify(item);
    var field = item.warmth;
    var clothing = ["top", "bottom", "dress", "outerwear"].indexOf(item.category) !== -1;
    var delta = 0;
    var inferred = false;
    var coldLightTop = (item.category === "top" || item.category === "dress") && temp <= cfg.cold && /短袖|T恤|Polo|POLO|polo/.test(item.name || "") && !/长袖/.test(item.name || "");
    if (field && clothing) {
      if (temp <= cfg.cold && field === "warm") delta += 6;
      if (temp > cfg.cold && temp < cfg.cool && field === "medium") delta += 5;
      if (temp >= cfg.hot && field === "light") delta += 4;
      if (temp <= cfg.cold && field === "light" && !coldLightTop) delta -= 6;
      if (temp >= cfg.hot && (field === "warm" || field === "medium")) delta -= 8;
    }
    if ((g.heavy || g.lined) && !field) {
      if (temp <= cfg.cold) delta += g.heavy ? 12 : 7;
      else if (temp < cfg.cool) delta -= 5;
      else delta -= 12;
      inferred = true;
    }
    if (item.category === "outerwear" && temp <= cfg.cold && !g.heavy && !g.lined && field !== "warm") {
      delta -= 4;
      inferred = true;
    }
    if (g.shorts && item.category === "bottom") {
      if (temp <= cfg.cold) { delta -= 14; inferred = true; }
      else if (temp >= cfg.hot) { delta += 3; inferred = true; }
    }
    if (coldLightTop) {
      delta -= 8;
      inferred = true;
    }
    if (g.longSleeve && (item.category === "top" || item.category === "outerwear") && temp <= cfg.cold) {
      delta += 5;
      inferred = true;
    }
    if (g.longSleeve && (item.category === "top" || item.category === "outerwear") && temp >= cfg.hot) {
      delta -= 4;
      inferred = true;
    }
    if (g.sunShell && temp <= cfg.cold) {
      delta -= 10;
      inferred = true;
    }
    return { delta: delta, inferred: inferred };
  }

  function occasionAdjustment(item, occasion, temp, cfg) {
    var g = classify(item);
    var style = item.style || "";
    var name = item.name || "";
    var delta = 0;
    if (occasion === "daily") {
      if (style === "casual") delta += 6;
      if (/针织|T恤|长裤|休闲|Polo|POLO|polo/.test(name)) delta += 2;
      if (g.keep) delta -= 6;
      if (g.baseLayer) delta -= 8;
    } else if (occasion === "formal") {
      if (style === "formal") delta += 8;
      else if (style === "smart") delta += 4;
      if (/衬衫|针织|Polo|POLO|polo|长裤|夹克|皮鞋/.test(name)) delta += 5;
      if (/正装|商务|免烫/.test(name)) delta += 5;
      if (!(temp != null && cfg && temp >= cfg.hot) && /长袖/.test(name) && /衬衫/.test(name)) delta += 4;
      if (/运动裤|卫衣|短裤|跑鞋|帽|紧身/.test(name) || g.running) delta -= 10;
      if (g.dressShoe) delta += 4;
      if (g.shortSleeve && !(temp != null && cfg && temp >= cfg.hot)) delta -= 3;
      if (g.keep || g.baseLayer) delta -= 8;
    } else if (occasion === "work") {
      if (style === "smart") delta += 3;
      if (/Polo|POLO|polo|T恤|牛仔裤|休闲裤|运动鞋/.test(name)) delta += 3;
      if (g.running) delta += 3;
      if (/徒步|登山/.test(name)) delta += 8;
      if (/正装|免烫/.test(name)) delta -= 6;
      if (g.dressShoe) delta -= 8;
      if (g.shorts) delta -= 4;
      if (g.keep) delta -= 4;
      if (g.baseLayer) delta -= 5;
      if (g.heavy) delta -= 3;
    } else if (occasion === "date") {
      if (/针织|衬衫|夹克|Polo|POLO|polo/.test(name)) delta += 5;
      if (/运动裤|卫衣|短裤|紧身/.test(name)) delta -= 6;
      if (g.keep) delta -= 6;
      if (g.baseLayer) delta -= 6;
      if (g.running) delta -= 2;
    } else if (occasion === "sport") {
      if (style === "sport") delta += 8;
      if (/运动|速干|跑鞋|短裤/.test(name) || g.running) delta += 6;
      if (/衬衫|皮鞋|正装|西装|西裤/.test(name) || g.dressShoe) delta -= 8;
      if (g.heavy) delta -= 6;
      if (g.baseLayer) delta -= 4;
      if (g.keep) delta -= 3;
    }
    return delta;
  }

  function preferredBonus(data, item, occasion, seasonalPenalty, temp, cfg) {
    if (!item || item.category !== "top" || seasonalPenalty) return 0;
    if (occasion === "sport") return 0;
    var table = (data.scoring && data.scoring.preferred_tops) || {};
    var raw = Number(table[item.id]) || 0;
    if (!raw) return 0;
    if (occasion === "work") return Math.min(4, raw);
    if (occasion === "formal") {
      var hot = temp != null && cfg && temp >= cfg.hot;
      var name = item.name || "";
      if (hot && /Polo|POLO|polo|短袖/.test(name) && !/正装/.test(name)) return Math.min(4, raw);
      if (!hot && /长袖/.test(name) && /衬衫/.test(name)) return Math.min(4, raw);
      return 0;
    }
    return Math.min(6, raw);
  }

  function itemScore(data, item, occasion, temp) {
    var cfg = tempConfig(data);
    var seasonal = seasonalAdjustment(item, temp, cfg);
    var score = occasionAdjustment(item, occasion, temp, cfg);
    score += seasonal.delta;
    score += preferredBonus(data, item, occasion, seasonal.delta < 0, temp, cfg);
    var tier = confirmationTier(data, item);
    if (tier === 1) score += 6;
    else if (tier === 2) score += 2;
    else score -= 2;
    if (item.lookalike) score -= 2;
    return score;
  }

  function colorScore(data, items) {
    var neutrals = new Set((data.scoring && data.scoring.neutrals) || []);
    var known = [];
    items.forEach(function (item) {
      if (item.color && item.color !== "other" && known.indexOf(item.color) === -1) known.push(item.color);
    });
    if (!known.length) return 0;
    var accents = known.filter(function (color) { return !neutrals.has(color); });
    return (known.length <= 3 ? 4 : -4) + (accents.length <= 1 ? 3 : -3);
  }

  function byScore(data, occasion, temp) {
    return function (a, b) {
      return itemScore(data, b, occasion, temp) - itemScore(data, a, occasion, temp) || String(a.id).localeCompare(String(b.id));
    };
  }

  function accessoryOk(item, occasion, temp, cfg) {
    var g = classify(item);
    if (g.optical) return false;
    if (/袜|内裤|护目镜|拖鞋/.test(item.name || "")) return false;
    if (g.winterHat && !(temp != null && temp <= cfg.cold)) return false;
    if ((occasion === "formal" || occasion === "date" || occasion === "work") && /帽/.test(item.name || "")) return false;
    return true;
  }

  function pickAccessory(data, pool, occasion, temp, picked) {
    var cfg = tempConfig(data);
    var best = null;
    var bestScore = 0;
    (pool || []).forEach(function (item) {
      if (picked.some(function (chosen) { return chosen.id === item.id; })) return;
      if (!accessoryOk(item, occasion, temp, cfg)) return;
      var score = itemScore(data, item, occasion, temp);
      var g = classify(item);
      if (g.sunGlass && (occasion === "daily" || occasion === "date")) score += 4;
      else if (g.sunGlass && occasion === "sport") score += 2;
      else if (/腕表|手表/.test(item.name || "")) score += 1;
      if (score > bestScore || (best && score === bestScore && String(item.id) < String(best.id))) {
        best = item;
        bestScore = score;
      }
    });
    return bestScore > 0 ? best : null;
  }

  function knownWarning(item) {
    var map = {
      "owned-white-knit-2026": "白色短袖针织上衣面料偏透，加内搭会热（已有记录，不是新判断）。",
      "owned-khaki-straight-2026": "卡其直筒长裤曾有裤脚堆积、建议改短的记录；是否已改未知。",
      "owned-dior-club-m1u": "DIOR 墨镜有镜框偏宽的历史意见；色号为候选，以镜腿刻字为准。"
    };
    return map[item.id] || "";
  }

  function buildWarnings(data, items, occasion, temp, dup) {
    var warnings = [];
    var cfg = tempConfig(data);
    items.forEach(function (item) {
      var known = knownWarning(item);
      if (known) warnings.push(known);
      var twin = dup.get(item.id);
      if (twin && !twin.retiredTwin) {
        warnings.push("和另一条记录名称或款号相同（" + twin.others.map(function (other) { return other.id; }).join("、") + "）。先别当成两件，这次没有合并或删除。");
      }
    });
    if (items.some(function (item) { return item.lookalike; })) {
      warnings.push("含同款参考或同款候选：主图不是已核对的同一件。");
    }
    if (items.some(function (item) { return /仅商品截图|商品截图/.test((item.image_kind || "") + (item.name || "")); })) {
      warnings.push("有主图只是商品截图，不能据此确认就是手里这一件。");
    }
    if (items.some(function (item) { return item.low_priority; })) {
      warnings.push("含不优先单品：该类别当时没有其他可穿选择，所以才用它。");
    }
    var inferred = temp != null && items.some(function (item) {
      return seasonalAdjustment(item, temp, cfg).inferred;
    });
    if (inferred) {
      warnings.push("厚薄有一部分是按商品名称里的羽绒、加绒、短裤或短袖推测的，不是实测，也没有改清单。");
    }
    if (temp != null && temp <= cfg.cold && items.some(function (item) {
      return item.category === "top" && /短袖|T恤|Polo|POLO|polo/.test(item.name || "") && !/长袖/.test(item.name || "");
    })) {
      warnings.push("上衣名称像短袖、Polo 或 T 恤，而填写的气温偏低。脱掉外套后可能不够，这是按名称推测。");
    }
    if (temp != null && temp < cfg.cool && !items.some(function (item) { return item.category === "outerwear"; })) {
      warnings.push("填写了 " + temp + "℃，但没有合适的外套可加。请按实际天气决定，这里没有补一件。");
    }
    if (occasion === "formal" && !items.some(function (item) { return /长袖/.test(item.name || "") && /衬衫/.test(item.name || ""); })) {
      warnings.push("这套没有用长袖衬衫。若衣橱里有，多半是因为填写的气温更适合短袖，不是因为没有衬衫。");
    }
    return warnings.filter(function (warning, index) { return warnings.indexOf(warning) === index; });
  }

  function explain(data, items, temp) {
    var parts = items.map(function (item) {
      var evidence = ownershipEvidence(data, item);
      return labelOf(data.categories, item.category, item.category) + "（" + (evidence.kind === "local" ? "本机确认仍保留" : "备注确认仍保留") + "）";
    });
    var reasons = [parts.join("、") + "。"];
    if (temp == null) reasons.push("温度未知，不作保暖判断。没有把缺外套理解成适合今天。");
    else reasons.push("这些单品过了 " + temp + "℃ 的厚薄门槛。不是天气预报，也没有试穿。");
    return reasons;
  }

  function outfitId(items) {
    return items.map(function (item) { return item.id; }).join("+");
  }

  function coreKey(items) {
    return items.filter(function (item) {
      return ["top", "bottom", "dress"].indexOf(item.category) !== -1;
    }).map(function (item) { return item.id; }).sort().join("+");
  }

  function recommendOutfits(data, items, options) {
    var opts = options || {};
    var occasion = opts.occasion || "daily";
    var temp = parseTemp(opts.tempText);
    var withAccessory = !!opts.withAccessory;
    var cfg = tempConfig(data);
    var band = tempBand(temp, cfg);
    var dup = duplicateIndex(items || []);
    var general = ["这是根据保留证据和厚薄门槛做的筛选，没有上身试穿，也没有改脸、肤色或体型。"];
    var held = [];
    var review = [];
    var blocked = [];
    var proven = [];
    (items || []).forEach(function (item) {
      if (!eligible(data, item)) return;
      var twin = dup.get(item.id);
      if (twin && twin.retiredTwin) {
        held.push({
          id: item.id,
          name: item.name,
          reason: "同名或同款号已有「已淘汰/不常穿」记录，自动搭配先跳过。单品仍留在衣橱，没有删除。"
        });
        return;
      }
      var evidence = ownershipEvidence(data, item);
      if (!evidence.proven) {
        review.push({ id: item.id, name: item.name, kind: evidence.kind, reason: evidence.reason });
        return;
      }
      if ((item.category === "accessory" || item.category === "bag") && !withAccessory) return;
      var warmth = warmthOk(item, temp, cfg);
      var fitsOccasion = occasionOk(item, occasion);
      if (!warmth.ok || !fitsOccasion) {
        blocked.push({ id: item.id, name: item.name, reason: !warmth.ok ? warmth.reason : "不适合当前场合。" });
        return;
      }
      proven.push(item);
    });
    general.push("状态写成可穿，但没有「已确认仍在、可穿用」或本机确认的，有 " + review.length + " 件。这些没有拿来拼方案。");
    general.push("没有使用只凭购买记录或款号核实标成可穿的衣服来补齐。");
    if (temp == null) {
      general.push("没有填写气温。温度未知，方案不作保暖判断，也没有把「不加外套」当成适合今天的天气。清单里的 24℃ 不会自动当成当日气温。");
    } else {
      general.push("只按你填写的 " + temp + "℃ 做门槛，不是天气预报。厚薄没写明的，在需要保暖时视为证据不足，不猜测材质。");
    }
    blocked.forEach(function (entry) {
      general.push("已有保留证据但这次不用：" + entry.name + "。" + entry.reason);
    });

    function pool(cat) {
      var inCat = proven.filter(function (item) { return item.category === cat; });
      var normal = inCat.filter(function (item) { return !item.low_priority; });
      return (normal.length ? normal : inCat).sort(byScore(data, occasion, temp)).slice(0, POOL_CAP);
    }
    var tops = pool("top");
    var bottoms = pool("bottom");
    var dresses = pool("dress");
    var shoes = pool("shoes");
    var outers = [];
    if (band === "cold") outers = pool("outerwear");
    else if (band === "cool") outers = pool("outerwear");
    var needOuter = band === "cold" || band === "cool";
    var gaps = [];
    if (!tops.length && !dresses.length) gaps.push("没有已确认仍保留、并且适合这个场合和气温的上衣或连衣裙。");
    if (!dresses.length && !bottoms.length) gaps.push("没有已确认仍保留、并且适合这个场合和气温的下装。");
    if (!shoes.length) gaps.push("没有已确认仍保留、并且适合这个场合的鞋。");
    if (needOuter && !outers.length) gaps.push("这个气温需要已确认仍保留的合适外套，衣橱里没有能同时满足保留证据和厚薄的外套。");
    if (band === "cold" && blocked.some(function (entry) { return /短袖|Polo|T 恤/.test(entry.reason); })) {
      gaps.push("短袖不能靠外层羽绒凑成一套。");
    }
    var canBuild = ((tops.length && bottoms.length) || dresses.length) && shoes.length && (!needOuter || outers.length);
    if (!canBuild) {
      general.push("衣橱证据不足，没有拼成一套。");
      return { outfits: [], general: general, heldBack: held, review: review, blocked: blocked, gaps: gaps, temp: temp, warmthJudged: temp != null };
    }
    if (pool("bottom").length && pool("bottom").every(function (item) { return item.low_priority; })) {
      general.push("下装只有不优先单品通过了门槛，这次才会用它。");
    }
    var order = (data.categories || []).map(function (row) { return row.id; });
    var bases = [];
    tops.forEach(function (top) { bottoms.forEach(function (bottom) { bases.push([top, bottom]); }); });
    dresses.forEach(function (dress) { bases.push([dress]); });
    var outerChoices = needOuter ? outers : [null];
    var candidates = [];
    bases.forEach(function (base) {
      shoes.forEach(function (shoe) {
        outerChoices.forEach(function (outer) {
          var picked = base.concat([shoe, outer]).filter(Boolean);
          if (withAccessory) {
            var extra = pickAccessory(data, pool("accessory"), occasion, temp, picked);
            if (extra && warmthOk(extra, temp, cfg).ok && occasionOk(extra, occasion)) picked.push(extra);
          }
          picked.sort(function (a, b) {
            return order.indexOf(a.category) - order.indexOf(b.category) || String(a.id).localeCompare(String(b.id));
          });
          var score = picked.reduce(function (sum, item) { return sum + itemScore(data, item, occasion, temp); }, 0) + colorScore(data, picked);
          candidates.push({ id: outfitId(picked), items: picked, score: Math.round(score * 10) / 10 });
        });
      });
    });
    var bestById = new Map();
    candidates.forEach(function (candidate) {
      var prev = bestById.get(candidate.id);
      if (!prev || candidate.score > prev.score) bestById.set(candidate.id, candidate);
    });
    candidates = Array.from(bestById.values()).sort(function (a, b) { return b.score - a.score || a.id.localeCompare(b.id); });
    var primary = candidates[0];
    var backup = null;
    for (var i = 1; primary && i < candidates.length; i += 1) {
      var mainPiece = primary.items.find(function (item) { return item.category === "top" || item.category === "dress"; });
      var otherPiece = candidates[i].items.find(function (item) { return item.category === "top" || item.category === "dress"; });
      if (mainPiece && otherPiece && mainPiece.id === otherPiece.id) continue;
      if (coreKey(primary.items) === coreKey(candidates[i].items)) continue;
      backup = candidates[i];
      break;
    }
    if (!backup) general.push("没有另一件已确认仍保留的上衣或连衣裙，所以没有备选，没有用未证实的单品凑第二套。");
    var selected = [primary].concat(backup ? [backup] : []);
    var outfits = selected.map(function (candidate, index) {
      var unknown = temp == null;
      return {
        id: candidate.id,
        role: index === 0 ? "primary" : "backup",
        title: unknown ? (index === 0 ? "已确认单品组合" : "另一组已确认单品") : (index === 0 ? "主要搭配" : "备选搭配"),
        warmthJudged: temp != null,
        items: candidate.items,
        warnings: buildWarnings(data, candidate.items, occasion, temp, dup).filter(function (warning) {
          return warning.indexOf("脱掉外套后可能不够") === -1 && warning.indexOf("没有合适的外套") === -1;
        }),
        reasons: explain(data, candidate.items, temp),
        score: candidate.score
      };
    });
    return { outfits: outfits, general: general, heldBack: held, review: review, blocked: blocked, gaps: gaps, temp: temp, warmthJudged: temp != null };
  }

  function countsOf(items) {
    var counts = { total: 0, with_images: 0, wearable: 0, record: 0, retired: 0, womens: 0 };
    (items || []).forEach(function (item) {
      counts.total += 1;
      if (item.image) counts.with_images += 1;
      if (item.status === "可穿") counts.wearable += 1;
      else if (item.status === "已购·仅记录") counts.record += 1;
      else if (item.status === "已淘汰/不常穿") counts.retired += 1;
      else if (item.status === "女款待核") counts.womens += 1;
    });
    return counts;
  }

  function countsDiffer(live, declared) {
    if (!declared) return false;
    return ["total", "with_images", "wearable", "record", "retired", "womens"].some(function (key) {
      return live[key] !== declared[key];
    });
  }

  function filterItems(data, items, query) {
    var q = query || {};
    var text = String(q.query || "").trim().toLowerCase();
    return (items || []).filter(function (item) {
      var culled = item.status === "已淘汰/不常穿";
      if (q.culledOnly) {
        if (!culled) return false;
      } else if (culled) return false;
      if (q.category && q.category !== "all" && item.category !== q.category) return false;
      if (!q.culledOnly) {
        if (q.statusFilter === "wearable" && item.status !== "可穿") return false;
        if (q.statusFilter === "record" && item.status !== "已购·仅记录") return false;
        if (q.statusFilter === "womens" && item.status !== "女款待核") return false;
      }
      if (q.source && q.source !== "all") {
        var sources = item.sources || [];
        if (q.source === "none") {
          if (sources.length) return false;
        } else if (sources.indexOf(q.source) === -1) return false;
      }
      if (text) {
        var hay = [
          item.name, item.brand, item.note, item.retire_reason, item.image_kind, item.id, item.status,
          labelOf(data.categories, item.category),
          labelOf(data.colors, item.color),
          (item.sources || []).join(" ")
        ].join(" ").toLowerCase();
        if (hay.indexOf(text) === -1) return false;
      }
      return true;
    });
  }

  function safeImage(src) {
    if (src == null || src === "") return null;
    var value = String(src);
    return /^images\/[A-Za-z0-9._-]+$/.test(value) ? value : null;
  }

  function safeHttpUrl(url) {
    if (!url) return "";
    try {
      var parsed = new URL(String(url), "https://example.invalid");
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return String(url);
    } catch (err) {
      return "";
    }
    return "";
  }

  function cleanText(value, max) {
    var text = String(value == null ? "" : value).replace(/\u0000/g, "").trim();
    if (text.length > max) text = text.slice(0, max);
    return text;
  }

  function hasPrivatePayload(text) {
    return /data:image\//i.test(text) || /(?:^|[^\d])1[3-9]\d{9}(?!\d)/.test(text) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  }

  function validId(id) {
    if (id === "__proto__" || id === "constructor" || id === "prototype") return false;
    return /^[A-Za-z0-9._-]{1,80}$/.test(id);
  }

  function stripMarkup(text) {
    var raw = String(text || "");
    var stripped = /<[^>]*>/.test(raw) || /javascript:/i.test(raw);
    var cleaned = raw.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "");
    return { text: cleaned, stripped: stripped && cleaned !== raw };
  }

  function redactSensitive(text) {
    var hits = [];
    var next = String(text || "").replace(/(^|[^\d])(1[3-9]\d{9})(?!\d)/g, function (all, prefix, phone) {
      hits.push("疑似电话已打码，其余文字保留");
      return prefix + "[已打码]";
    });
    next = next.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, function () {
      hits.push("邮箱已打码，其余文字保留");
      return "[已打码]";
    });
    return { text: next, hits: hits };
  }

  function classifyStoredImage(src, scope) {
    if (src == null || src === "") return { image: null, image_scope: "" };
    var value = String(src).trim();
    if (/^(javascript|vbscript|data):/i.test(value) && !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) {
      return { image: null, image_scope: "", discard: "脚本协议、网页或 SVG 不能当图片保存" };
    }
    if (/^images\/[A-Za-z0-9._-]+$/.test(value)) return { image: value, image_scope: "repo" };
    if (scope !== "local") {
      return { image: null, image_scope: "", discard: "公开字段只接受仓库里的 images/ 相对路径，这条没有写进公开清单" };
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        var parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { image: null, image_scope: "", discard: "图片协议不是 http 或 https" };
        }
      } catch (err) {
        return { image: null, image_scope: "", discard: "外链无法解析，没有保存" };
      }
      return { image: value, image_scope: "local-remote", kept: "外链只留在本机。打开图片时会向该网址请求，不会写进公开清单。" };
    }
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) {
      if (value.length > 500000) return { image: null, image_scope: "", discard: "本机图片数据超过约 500KB，没有保存" };
      return { image: value, image_scope: "local-data", kept: "图片数据只留在本机，不会写进公开仓库。页面不能分辨是不是人脸，请不要导入本人照片。" };
    }
    return { image: null, image_scope: "", discard: "图片格式不支持。可用仓库相对路径、http(s)，或 png/jpeg/webp/gif 的 data 图片。" };
  }

  function localImageSrc(src) {
    var judged = classifyStoredImage(src, "local");
    if (!judged.image) return null;
    if (judged.image_scope === "repo" || judged.image_scope === "local-remote" || judged.image_scope === "local-data") return judged.image;
    return null;
  }

  function sanitizeItem(data, raw, options) {
    var scope = options && options.scope === "local" ? "local" : "public";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "不是单品对象" };
    var id = cleanText(raw.id, 80);
    if (!validId(id)) return { ok: false, id: id, reason: "编号无效" };
    var nameResult = stripMarkup(cleanText(raw.name, 180));
    var name = nameResult.text;
    if (!name) return { ok: false, id: id, reason: "缺少名称" };
    if (/data:image\//i.test(name) || /javascript:/i.test(String(raw.name || ""))) {
      return { ok: false, id: id, reason: "名称里有脚本或图片数据，已整件拒绝" };
    }
    var categories = (data.categories || []).map(function (row) { return row.id; });
    if (categories.indexOf(raw.category) === -1) return { ok: false, id: id, reason: "分类不在清单允许的范围内" };
    var statuses = (data.statuses || []).map(function (row) { return row.id; });
    if (statuses.indexOf(raw.status) === -1) return { ok: false, id: id, reason: "状态不在允许的四种之内" };
    var warnings = [];
    var changes = [];
    if (nameResult.stripped) changes.push({ id: id, field: "name", action: "去掉标签", reason: "名称里的 HTML 或脚本协议已去掉，其余文字保留" });
    function cleanNote(value, field, max) {
      var original = String(value == null ? "" : value);
      var clipped = original.length > max;
      var marked = stripMarkup(cleanText(original, max));
      var redacted = redactSensitive(marked.text);
      if (clipped) changes.push({ id: id, field: field, action: "截断", reason: "超过 " + max + " 字，多出来的没有保存" });
      if (marked.stripped) changes.push({ id: id, field: field, action: "去掉标签", reason: "HTML 或脚本协议已去掉，其余文字保留" });
      redacted.hits.forEach(function (hit) { changes.push({ id: id, field: field, action: "打码", reason: hit }); });
      return redacted.text;
    }
    var note = cleanNote(raw.note, "note", scope === "local" ? 2000 : 500);
    var retire = cleanNote(raw.retire_reason, "retire_reason", 300);
    var stored = classifyStoredImage(raw.image, scope);
    var image = stored.image;
    var imageScope = stored.image_scope || "";
    if (raw.image && stored.discard) {
      changes.push({ id: id, field: "image", action: "未采用", reason: stored.discard });
      warnings.push(stored.discard);
    } else if (stored.kept) {
      changes.push({ id: id, field: "image", action: "留在本机", reason: stored.kept });
    }
    var colors = (data.colors || []).map(function (row) { return row.id; });
    var color = cleanText(raw.color, 40);
    if (color && colors.indexOf(color) === -1) {
      color = "";
      warnings.push("颜色值无法识别，已留空");
    }
    var warmth = cleanText(raw.warmth, 20);
    if (["light", "medium", "warm", ""].indexOf(warmth) === -1) warmth = "";
    var style = cleanText(raw.style, 24);
    if (style && !/^[a-z0-9_-]{1,24}$/.test(style)) style = "";
    var allowedSources = ["京东", "淘宝", "得物", "免税店", "其他"];
    var sources = [];
    (Array.isArray(raw.sources) ? raw.sources : []).forEach(function (source) {
      var nameOfSource = cleanText(source, 20);
      if (allowedSources.indexOf(nameOfSource) !== -1 && sources.indexOf(nameOfSource) === -1) sources.push(nameOfSource);
    });
    var imageKind = cleanText(raw.image_kind, 80);
    var lookalike = raw.lookalike === true || /同款/.test(imageKind) || /同款/.test(name);
    if (lookalike && !/同款/.test(imageKind)) imageKind = imageKind || "同款参考，非同一件";
    var item = {
      id: id,
      name: name,
      brand: cleanText(raw.brand, 80),
      category: raw.category,
      color: color,
      style: style,
      warmth: warmth,
      status: raw.status,
      sources: sources,
      lookalike: !!lookalike,
      low_priority: raw.low_priority === true,
      image: image,
      image_scope: imageScope,
      image_kind: imageKind,
      note: note,
      retire_reason: retire
    };
    return { ok: true, item: item, warnings: warnings, changes: changes };
  }

  function isEmptyField(value) {
    return value == null || value === "" || (Array.isArray(value) && value.length === 0);
  }

  function cloneLocal(local) {
    var next = emptyLocal();
    var source = local || emptyLocal();
    Object.keys(source.overrides || {}).forEach(function (key) {
      if (!validId(key)) return;
      var row = source.overrides[key] || {};
      var copy = {};
      if (row.status) copy.status = row.status;
      if (row.retire_reason) copy.retire_reason = row.retire_reason;
      if (row.retain === "yes" || row.retain === "no") copy.retain = row.retain;
      if (typeof row.localImage === "string") copy.localImage = row.localImage;
      if (row.image_scope) copy.image_scope = row.image_scope;
      if (row.fill && typeof row.fill === "object") copy.fill = Object.assign({}, row.fill);
      next.overrides[key] = copy;
    });
    (source.extraItems || []).forEach(function (item) { next.extraItems.push(Object.assign({}, item)); });
    return next;
  }

  function applyOverride(item, override, statuses) {
    if (!override) return item;
    var next = Object.assign({}, item);
    if (override.status && statuses.indexOf(override.status) !== -1) {
      next.status = override.status;
      if (override.status === "已淘汰/不常穿") {
        next.retire_reason = override.retire_reason || item.retire_reason || "仅在本机标为已淘汰/不常穿，未写入公开清单。";
      }
    }
    if (override.retain === "yes" || override.retain === "no") next._retainLocal = override.retain;
    if (override.localImage) {
      var localPicture = classifyStoredImage(override.localImage, "local");
      if (localPicture.image && localPicture.image_scope !== "repo") {
        next.image = localPicture.image;
        next.image_scope = localPicture.image_scope;
      }
    }
    var fill = override.fill || {};
    FILL_KEYS.forEach(function (key) {
      if (isEmptyField(item[key]) && !isEmptyField(fill[key])) next[key] = fill[key];
    });
    return next;
  }

  function mergeCatalog(publicItems, local, statuses) {
    var state = local || emptyLocal();
    var allowed = statuses && statuses.length ? statuses : ["可穿", "已购·仅记录", "已淘汰/不常穿", "女款待核"];
    var seen = Object.create(null);
    var merged = [];
    (publicItems || []).forEach(function (item) {
      seen[item.id] = true;
      merged.push(applyOverride(item, state.overrides && state.overrides[item.id], allowed));
    });
    (state.extraItems || []).forEach(function (item) {
      if (!item || seen[item.id]) return;
      seen[item.id] = true;
      merged.push(applyOverride(item, state.overrides && state.overrides[item.id], allowed));
    });
    return merged;
  }

  function parseIncoming(raw) {
    var text = raw;
    if (typeof raw !== "string") {
      if (Array.isArray(raw)) return { ok: true, items: raw };
      if (raw && Array.isArray(raw.items)) return { ok: true, items: raw.items };
      return { ok: false, error: "导入文件里没有 items 数组。" };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: "文件过大，已停止导入，现有衣橱没有改动。" };
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (err) { return { ok: false, error: "这不是合法 JSON，没有导入。" }; }
    if (Array.isArray(parsed)) return { ok: true, items: parsed };
    if (parsed && Array.isArray(parsed.items)) return { ok: true, items: parsed.items };
    return { ok: false, error: "导入文件里没有 items 数组，没有导入。" };
  }

  function previewMerge(data, publicItems, local, raw) {
    var parsed = parseIncoming(raw);
    if (!parsed.ok) return parsed;
    if (parsed.items.length > MAX_EXTRA + (publicItems || []).length) {
      return { ok: false, error: "导入条数过多，已停止，现有衣橱没有改动。" };
    }
    var safeNext = cloneLocal(local);
    var statusNext = cloneLocal(local);
    var incomingIds = Object.create(null);
    var added = [];
    var filled = [];
    var statusChanges = [];
    var rejected = [];
    var imageDropped = 0;
    var notices = [];
    var seenFile = Object.create(null);
    var statuses = (data.statuses || []).map(function (row) { return row.id; });
    var effective = mergeCatalog(publicItems, local, statuses);
    var currentById = new Map(effective.map(function (item) { return [item.id, item]; }));

    parsed.items.forEach(function (rawItem) {
      var result = sanitizeItem(data, rawItem, { scope: "local" });
      if (!result.ok) {
        rejected.push({ id: result.id || "", reason: result.reason });
        notices.push({ id: result.id || "", field: "item", action: "拒绝整件", reason: result.reason });
        return;
      }
      var item = result.item;
      if (seenFile[item.id]) {
        notices.push({ id: item.id, field: "id", action: "未采用", reason: "同一文件里这个编号出现了不止一次，只保留第一条。" });
        return;
      }
      seenFile[item.id] = true;
      (result.changes || []).forEach(function (change) { notices.push(change); });
      incomingIds[item.id] = true;
      var current = currentById.get(item.id);
      if (!current) {
        if (safeNext.extraItems.length >= MAX_EXTRA) {
          rejected.push({ id: item.id, reason: "本机新增已达上限，这件没有加入" });
          return;
        }
        safeNext.extraItems.push(item);
        statusNext.extraItems.push(Object.assign({}, item));
        added.push({ id: item.id, name: item.name });
        return;
      }
      var fill = {};
      var fields = [];
      FILL_KEYS.forEach(function (key) {
        if (key === "image") return;
        if (isEmptyField(current[key]) && !isEmptyField(item[key])) {
          fill[key] = item[key];
          fields.push(key);
        }
      });
      if (item.image_scope === "repo" && isEmptyField(current.image) && item.image) {
        fill.image = item.image;
        fields.push("image");
      } else if (item.image_scope && item.image_scope !== "repo") {
        if (safeImage(current.image)) {
          notices.push({ id: item.id, field: "image", action: "未覆盖", reason: "公开清单已有仓库图片，导入的外链或上传图不覆盖它，原图还在。" });
        } else if (item.image) {
          if (!safeNext.overrides[item.id]) safeNext.overrides[item.id] = {};
          if (!statusNext.overrides[item.id]) statusNext.overrides[item.id] = {};
          safeNext.overrides[item.id].localImage = item.image;
          safeNext.overrides[item.id].image_scope = item.image_scope;
          statusNext.overrides[item.id].localImage = item.image;
          statusNext.overrides[item.id].image_scope = item.image_scope;
          notices.push({ id: item.id, field: "image", action: "留在本机", reason: "这张图只补在本机，没有写进公开清单。" });
        }
      } else if (item.image && !isEmptyField(current.image) && item.image !== current.image) {
        notices.push({ id: item.id, field: "image", action: "未覆盖", reason: "已有图片和导入图片不同，保留原来的，没有静默替换。" });
      }
      if (fields.length) {
        if (!safeNext.overrides[item.id]) safeNext.overrides[item.id] = {};
        safeNext.overrides[item.id].fill = Object.assign({}, (safeNext.overrides[item.id].fill || {}), fill);
        if (!statusNext.overrides[item.id]) statusNext.overrides[item.id] = {};
        statusNext.overrides[item.id].fill = Object.assign({}, (statusNext.overrides[item.id].fill || {}), fill);
        filled.push({ id: item.id, fields: fields });
      }
      if (item.status !== current.status) {
        statusChanges.push({ id: item.id, from: current.status, to: item.status, name: current.name || item.name });
        if (!statusNext.overrides[item.id]) statusNext.overrides[item.id] = {};
        statusNext.overrides[item.id].status = item.status;
        if (item.status === "已淘汰/不常穿") {
          statusNext.overrides[item.id].retire_reason = item.retire_reason || "导入文件中的状态，仅保存在本机。";
        }
      }
    });

    var keptDespiteOmission = effective.filter(function (item) { return !incomingIds[item.id]; }).length;
    imageDropped = notices.filter(function (notice) { return notice.field === "image" && notice.action === "未采用"; }).length;

    return {
      ok: true,
      preview: {
        added: added,
        filled: filled,
        statusChanges: statusChanges,
        rejected: rejected,
        notices: notices,
        imageDropped: imageDropped,
        keptDespiteOmission: keptDespiteOmission,
        incomingCount: parsed.items.length,
        safeNext: safeNext,
        statusNext: statusNext
      }
    };
  }

  function readLocal(storage) {
    try {
      if (!storage) return { ok: true, state: emptyLocal(), empty: true };
      var raw = storage.getItem(LOCAL_KEY);
      if (!raw) return { ok: true, state: emptyLocal(), empty: true };
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed !== "object") {
        return { ok: false, state: emptyLocal(), error: "本机缓存版本无法识别。页面先用公开清单，没有覆盖或清空这份缓存。" };
      }
      var state = emptyLocal();
      var overrides = parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {};
      Object.keys(overrides).forEach(function (key) {
        if (!validId(key)) return;
        var row = overrides[key] || {};
        var copy = {};
        if (typeof row.status === "string") copy.status = row.status;
        if (typeof row.retire_reason === "string") copy.retire_reason = cleanText(row.retire_reason, 300);
        if (row.retain === "yes" || row.retain === "no") copy.retain = row.retain;
        if (typeof row.localImage === "string") copy.localImage = row.localImage;
        if (typeof row.image_scope === "string") copy.image_scope = row.image_scope;
        if (row.fill && typeof row.fill === "object") {
          copy.fill = {};
          FILL_KEYS.forEach(function (field) {
            if (row.fill[field] != null) copy.fill[field] = row.fill[field];
          });
        }
        state.overrides[key] = copy;
      });
      if (Array.isArray(parsed.extraItems)) {
        var seenExtra = Object.create(null);
        parsed.extraItems.slice(0, MAX_EXTRA).forEach(function (item) {
          if (!item || !validId(item.id) || seenExtra[item.id]) return;
          seenExtra[item.id] = true;
          state.extraItems.push(item);
        });
      }
      return { ok: true, state: state, empty: false };
    } catch (err) {
      return { ok: false, state: emptyLocal(), error: "本机数据读不出来（" + (err && err.message ? err.message : "未知错误") + "）。页面先用公开清单，没有改写缓存。" };
    }
  }

  function writeLocal(storage, state) {
    try {
      if (!storage) throw new Error("没有可用的本地存储");
      var payload = { version: 1, overrides: {}, extraItems: state.extraItems || [] };
      Object.keys(state.overrides || {}).forEach(function (key) {
        if (!validId(key)) return;
        payload.overrides[key] = state.overrides[key];
      });
      storage.setItem(LOCAL_KEY, JSON.stringify(payload));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "本机保存失败（" + (err && err.message ? err.message : "未知错误") + "）。这次修改只留在当前页面，刷新后可能丢失。公开清单没有被改写。" };
    }
  }

  function localIsEmpty(state) {
    if (!state) return true;
    return !Object.keys(state.overrides || {}).length && !(state.extraItems && state.extraItems.length);
  }

  return {
    LOCAL_KEY: LOCAL_KEY,
    emptyLocal: emptyLocal,
    parseTemp: parseTemp,
    initialTempText: initialTempText,
    eligible: eligible,
    isLoafer: isLoafer,
    isDeepCoffee: isDeepCoffee,
    modelKeys: modelKeys,
    duplicateIndex: duplicateIndex,
    confirmationTier: confirmationTier,
    ownershipEvidence: ownershipEvidence,
    warmthOk: warmthOk,
    occasionOk: occasionOk,
    localImageSrc: localImageSrc,
    itemScore: itemScore,
    recommendOutfits: recommendOutfits,
    countsOf: countsOf,
    countsDiffer: countsDiffer,
    filterItems: filterItems,
    safeImage: safeImage,
    safeHttpUrl: safeHttpUrl,
    sanitizeItem: sanitizeItem,
    mergeCatalog: mergeCatalog,
    previewMerge: previewMerge,
    readLocal: readLocal,
    writeLocal: writeLocal,
    localIsEmpty: localIsEmpty,
    labelOf: labelOf,
    classify: classify
  };
});

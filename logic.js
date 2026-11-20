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

  function confirmationTier(data, item) {
    var core = data.core_items || [];
    var note = item.note || "";
    if (core.indexOf(item.id) !== -1 || /已确认仍在|已核实/.test(note)) return 1;
    if (/已购可穿/.test(note)) return 2;
    return 3;
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
      var tier = confirmationTier(data, item);
      var certainty = tier === 1 ? "较早确认" : tier === 2 ? "备注为已购可穿" : "仅状态为可穿";
      return labelOf(data.categories, item.category, item.category) + "（" + certainty + "）";
    });
    var reasons = [parts.join("、") + "。"];
    if (temp == null) reasons.push("未填气温，所以没有加外套，也没有按天气改厚薄。");
    else reasons.push("气温用的是填写的 " + temp + "℃，不是天气预报。");
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
    var general = ["这是根据清单字段做的筛选，没有上身试穿，也没有改脸、肤色或体型。"];
    var dup = duplicateIndex(items || []);
    var held = [];
    var available = [];
    (items || []).forEach(function (item) {
      if (!eligible(data, item)) return;
      var twin = dup.get(item.id);
      if (twin && twin.retiredTwin) {
        held.push({
          id: item.id,
          name: item.name,
          reason: "同名或同款号已有「已淘汰/不常穿」记录，自动搭配先跳过，避免把淘汰款再穿出去。单品仍留在衣橱，没有删除。"
        });
        return;
      }
      available.push(item);
    });
    if (temp == null) general.push("没有填写气温，不推测今天冷热，也不自动加外套。");
    else general.push("只使用你填写的 " + temp + "℃。清单里的参考气温不会自动当成今天。厚薄字段没填的，不会被补写成某种材质。");
    if (occasion === "work") {
      general.push("「上班工地」按方便走动来选，少用正装皮鞋。这是对场合名称的理解，不是对工作内容的记录。");
    } else if (occasion === "formal") {
      general.push("正式场合只在现有可穿单品里挑相对得体的，没有编造清单外的西装。");
    } else if (occasion === "sport") {
      general.push("运动场合优先能看出运动属性的单品。");
    }
    if (!withAccessory) general.push("默认不加配饰和包，避免在不知道当天的情况下硬配墨镜或帽子。");
    if (!available.length) {
      return { outfits: [], general: general.concat(["当前没有能进入搭配的已确认可穿单品。"]), heldBack: held, temp: temp };
    }

    var order = (data.categories || []).map(function (row) { return row.id; });
    var pools = {};
    order.forEach(function (cat) {
      var inCat = available.filter(function (item) { return item.category === cat; });
      var normal = inCat.filter(function (item) { return !item.low_priority; });
      var used = normal.length ? normal : inCat;
      if (!normal.length && inCat.length) {
        general.push(labelOf(data.categories, cat, cat) + "只有不优先单品，这次会用它，因为没有其他选择。");
      }
      pools[cat] = used.sort(byScore(data, occasion, temp)).slice(0, POOL_CAP);
    });

    var bases = [];
    (pools.top || []).forEach(function (top) {
      (pools.bottom || []).forEach(function (bottom) { bases.push([top, bottom]); });
    });
    (pools.dress || []).forEach(function (dress) { bases.push([dress]); });
    if (!bases.length) {
      return { outfits: [], general: general.concat(["缺少可搭配的上衣和下装，也没有连衣裙，组不出一套。"]), heldBack: held, temp: temp };
    }

    var cfg = tempConfig(data);
    var shoes = pools.shoes && pools.shoes.length ? pools.shoes : [null];
    if (!(pools.shoes && pools.shoes.length)) general.push("缺少可搭配的鞋，方案会不完整。");
    var outers = [null];
    var outerPool = pools.outerwear || [];
    if (temp != null && temp < cfg.cool) {
      var suitable = outerPool.filter(function (item) {
        var g = classify(item);
        if (g.sunShell && temp <= cfg.cold) return false;
        if ((g.heavy || g.lined) && temp > cfg.cold) return false;
        return true;
      });
      if (suitable.length) outers = suitable.slice(0, 8);
      else general.push("按填写的气温应该看外套，但没有合适的可穿外套。没有拿防晒衣当防寒，也没有在偏暖时硬加羽绒服。");
      if (outerPool.some(function (item) { return classify(item).heavy || classify(item).lined; }) && temp > cfg.cold) {
        general.push("羽绒服或加绒外套这次没有自动加入：填写的气温高于厚外套阈值。是否真的太厚，是按名称推测。");
      }
      if (outerPool.some(function (item) { return classify(item).sunShell; }) && temp <= cfg.cold) {
        general.push("防晒衣没有当成防寒外套。");
      }
    }

    var candidates = [];
    bases.forEach(function (base) {
      shoes.forEach(function (shoe) {
        outers.forEach(function (outer) {
          var picked = base.concat([shoe, outer]).filter(Boolean);
          if (withAccessory) {
            var extra = pickAccessory(data, pools.accessory || [], occasion, temp, picked);
            if (extra) picked.push(extra);
          }
          picked.sort(function (a, b) {
            return order.indexOf(a.category) - order.indexOf(b.category) || String(a.id).localeCompare(String(b.id));
          });
          var score = picked.reduce(function (sum, item) {
            return sum + itemScore(data, item, occasion, temp);
          }, 0) + colorScore(data, picked);
          candidates.push({
            id: outfitId(picked),
            items: picked,
            score: Math.round(score * 10) / 10
          });
        });
      });
    });
    var bestById = new Map();
    candidates.forEach(function (candidate) {
      var prev = bestById.get(candidate.id);
      if (!prev || candidate.score > prev.score) bestById.set(candidate.id, candidate);
    });
    candidates = Array.from(bestById.values());
    candidates.sort(function (a, b) { return b.score - a.score || a.id.localeCompare(b.id); });

    var primary = candidates[0];
    if (!primary) {
      return { outfits: [], general: general.concat(["当前条件无法形成完整搭配。"]), heldBack: held, temp: temp };
    }
    var backup = null;
    for (var i = 1; i < candidates.length; i += 1) {
      var mainPiece = primary.items.find(function (item) { return item.category === "top" || item.category === "dress"; });
      var otherPiece = candidates[i].items.find(function (item) { return item.category === "top" || item.category === "dress"; });
      if (mainPiece && otherPiece && mainPiece.id === otherPiece.id) continue;
      if (coreKey(primary.items) === coreKey(candidates[i].items)) continue;
      backup = candidates[i];
      break;
    }
    var selected = [primary];
    if (backup) selected.push(backup);
    else general.push("没有另一套不同上衣或连衣裙的备选，所以只给一套，没有凑第二套。");

    var outfits = selected.map(function (candidate, index) {
      return {
        id: candidate.id,
        role: index === 0 ? "primary" : "backup",
        title: index === 0 ? "主要搭配" : "备选搭配",
        items: candidate.items,
        warnings: buildWarnings(data, candidate.items, occasion, temp, dup),
        reasons: explain(data, candidate.items, temp),
        score: candidate.score
      };
    });
    return { outfits: outfits, general: general, heldBack: held, temp: temp };
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
    return /^[A-Za-z0-9._-]{1,80}$/.test(id);
  }

  function sanitizeItem(data, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "不是单品对象" };
    var id = cleanText(raw.id, 80);
    if (!validId(id)) return { ok: false, reason: "编号无效" };
    var name = cleanText(raw.name, 180);
    if (!name) return { ok: false, reason: "缺少名称" };
    if (hasPrivatePayload(name)) return { ok: false, id: id, reason: "名称里有电话、邮箱或图片数据，已整件拒绝" };
    var categories = (data.categories || []).map(function (row) { return row.id; });
    if (categories.indexOf(raw.category) === -1) return { ok: false, id: id, reason: "分类不在清单允许的范围内" };
    var statuses = (data.statuses || []).map(function (row) { return row.id; });
    if (statuses.indexOf(raw.status) === -1) return { ok: false, id: id, reason: "状态不在允许的四种之内" };
    var warnings = [];
    var note = cleanText(raw.note, 500);
    var retire = cleanText(raw.retire_reason, 300);
    if (hasPrivatePayload(note) || hasPrivatePayload(retire)) {
      note = "";
      retire = "";
      warnings.push("备注含电话、邮箱或图片数据，已去掉备注");
    }
    var image = safeImage(raw.image);
    if (raw.image && !image) {
      image = null;
      warnings.push("图片不是本仓库 images/ 下的相对路径，外链和上传图没有采用");
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
      image_kind: imageKind,
      note: note,
      retire_reason: raw.status === "已淘汰/不常穿" ? retire : cleanText(raw.retire_reason, 300)
    };
    return { ok: true, item: item, warnings: warnings };
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
    var statuses = (data.statuses || []).map(function (row) { return row.id; });
    var effective = mergeCatalog(publicItems, local, statuses);
    var currentById = new Map(effective.map(function (item) { return [item.id, item]; }));

    parsed.items.forEach(function (rawItem) {
      var result = sanitizeItem(data, rawItem);
      if (!result.ok) {
        rejected.push({ id: result.id || "", reason: result.reason });
        return;
      }
      if ((result.warnings || []).some(function (warning) { return warning.indexOf("图片") !== -1; })) imageDropped += 1;
      var item = result.item;
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
        if (isEmptyField(current[key]) && !isEmptyField(item[key])) {
          fill[key] = item[key];
          fields.push(key);
        }
      });
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

    return {
      ok: true,
      preview: {
        added: added,
        filled: filled,
        statusChanges: statusChanges,
        rejected: rejected,
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
        if (row.fill && typeof row.fill === "object") {
          copy.fill = {};
          FILL_KEYS.forEach(function (field) {
            if (row.fill[field] != null) copy.fill[field] = row.fill[field];
          });
        }
        state.overrides[key] = copy;
      });
      if (Array.isArray(parsed.extraItems)) {
        parsed.extraItems.slice(0, MAX_EXTRA).forEach(function (item) {
          if (item && validId(item.id)) state.extraItems.push(item);
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

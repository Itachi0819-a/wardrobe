(function () {
  const root = document.getElementById("app");

  const state = {
    data: null,
    tab: "suggest",
    occasion: "daily",
    tempText: "",
    generated: false,
    cat: "all",
    statusFilter: "wearable",
    source: "all",
    query: "",
    picked: null,
    showCulled: false,
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function labelOf(list, id, fallback) {
    const found = (list || []).find((x) => x.id === id);
    return found ? found.label : fallback || id || "";
  }

  function toneOf(status) {
    const found = (state.data.statuses || []).find((x) => x.id === status);
    return found ? found.tone : "neutral";
  }

  function statusLabel(status) {
    return labelOf(state.data.statuses, status, status);
  }

  function catLabel(cat) {
    return labelOf(state.data.categories, cat, cat);
  }

  function colorLabel(color) {
    return labelOf(state.data.colors, color, color);
  }

  function itemById(id) {
    return (state.data.items || []).find((item) => item.id === id) || null;
  }

  function isWearable(item) {
    return item && item.status === "可穿";
  }

  function isLoafer(item) {
    return /乐福/.test((item.name || "") + (item.note || ""));
  }

  function isDeepCoffee(item) {
    return /深咖/.test((item.name || "") + (item.note || ""));
  }

  function isLowPriority(item) {
    return !!(item && item.low_priority);
  }

  function targetStyle(occasion) {
    const found = (state.data.occasions || []).find((x) => x.id === occasion);
    return found ? found.style : "";
  }

  function parseTemp() {
    if (state.tempText === "" || state.tempText == null) return null;
    const value = Number(state.tempText);
    return Number.isFinite(value) ? value : null;
  }

  function itemScore(item, occasion, temp) {
    let score = 0;
    const style = targetStyle(occasion);
    if (style && item.style === style) score += 8;
    else if (
      style &&
      item.style &&
      ((style === "smart" && item.style === "formal") ||
        (style === "formal" && item.style === "smart"))
    ) {
      score += 3;
    }
    const text = item.name + (item.note || "") + (item.style || "");
    if (occasion === "formal" || occasion === "work") {
      if (/衬衫|针织|POLO|Polo|polo|长裤|夹克|皮鞋|墨镜/.test(text)) score += 5;
      if (/运动裤|卫衣|短裤|跑鞋|帽/.test(text) && occasion === "formal") score -= 8;
      if (/运动裤|卫衣|短裤/.test(text) && occasion === "work") score -= 3;
      if (item.category === "shoes" && /跑鞋|运动鞋|Adizero/.test(text) && occasion === "formal")
        score -= 6;
    }
    if (occasion === "date") {
      if (/墨镜|针织|衬衫|夹克/.test(text)) score += 4;
      if (/运动裤|卫衣/.test(text)) score -= 2;
    }
    if (occasion === "sport") {
      if (/运动|跑鞋|短裤|卫衣|运动裤|Adidas|速干/.test(text)) score += 8;
      if (/衬衫|皮鞋|正装|西装/.test(text)) score -= 8;
    }
    if (occasion === "daily") {
      if (/针织|T恤|长裤|休闲/.test(text)) score += 2;
    }
    if ((occasion === "formal" || occasion === "date") && item.category === "accessory" && /帽|滑雪/.test(text))
      score -= 6;
    if (item.lookalike) score -= 1;
    const tempCfg = (state.data.scoring && state.data.scoring.temp) || { cold: 12, cool: 20, hot: 26 };
    if (temp !== null && item.warmth && ["top", "bottom", "dress", "outerwear"].includes(item.category)) {
      if (temp <= tempCfg.cold && item.warmth === "warm") score += 6;
      if (temp > tempCfg.cold && temp < tempCfg.cool && item.warmth === "medium") score += 5;
      if (temp >= tempCfg.hot && item.warmth === "light") score += 6;
      if (temp >= tempCfg.hot && item.warmth === "warm") score -= 10;
    }
    if (item.category === "top") {
      const preferred = (state.data.scoring && state.data.scoring.preferred_tops) || {};
      if (preferred[item.id]) score += preferred[item.id];
    }
    return score;
  }

  function colorScore(items) {
    const neutrals = new Set((state.data.scoring && state.data.scoring.neutrals) || []);
    const known = [...new Set(items.map((item) => item.color).filter((color) => color && color !== "other"))];
    if (!known.length) return 0;
    const accents = known.filter((color) => !neutrals.has(color));
    return (known.length <= 3 ? 4 : -4) + (accents.length <= 1 ? 3 : -3);
  }

  function catOrder() {
    return (state.data.categories || []).map((x) => x.id);
  }

  function coreKey(items) {
    return items
      .filter((item) => ["top", "bottom", "dress"].includes(item.category))
      .map((item) => item.id)
      .sort()
      .join("+");
  }

  function outfitId(items) {
    const order = catOrder();
    return items
      .slice()
      .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.id.localeCompare(b.id))
      .map((item) => item.id)
      .join("+");
  }

  function buildWarnings(items, occasion, temp) {
    const warnings = [];
    if (items.some((item) => item.id === "owned-white-knit-2026")) {
      warnings.push("白色短袖针织上衣面料偏透，加内搭会热（已有记录，不是新判断）。");
    }
    if (items.some((item) => item.id === "owned-khaki-straight-2026")) {
      warnings.push("卡其直筒长裤曾有裤脚堆积、建议改短的记录；是否已改未知。");
    }
    if (items.some((item) => item.lookalike)) {
      warnings.push("含同款候选或同款参考：主图是同款或近似商品图，不能当成已核对为同一件。");
    }
    if (items.some((item) => isLowPriority(item))) {
      warnings.push("含不优先单品：这是最后才考虑的选择，因为当时没有更合适的同类单品。");
    }
    if (
      temp !== null &&
      items.some((item) => !item.warmth && ["top", "bottom", "dress", "outerwear", "shoes"].includes(item.category))
    ) {
      warnings.push("部分单品未填写厚薄，气温适配只供参考，没有补写舒适或材质标签。");
    }
    const tempCfg = (state.data.scoring && state.data.scoring.temp) || { cool: 20 };
    if (temp !== null && temp < tempCfg.cool && !items.some((item) => item.category === "outerwear")) {
      warnings.push("气温 " + temp + "℃，可穿衣物里没有可用外套，请按实际天气决定。");
    }
    if (occasion === "formal" && !items.some((item) => item.style === "formal" || item.style === "smart")) {
      warnings.push("当前可穿单品没有标记为正式或通勤，这套只是现有衣物里相对得体的组合，不是正装方案。");
    }
    if (items.some((item) => item.id === "owned-dior-club-m1u")) {
      warnings.push("DIOR 墨镜有镜框偏宽的历史意见；色号为高置信候选，以镜腿刻字为准。");
    }
    return warnings;
  }

  function recommendOutfits(occasion, temp) {
    const general = [];
    const available = (state.data.items || []).filter(
      (item) => isWearable(item) && !isLoafer(item) && !isDeepCoffee(item)
    );
    if (!available.length) return { outfits: [], general: ["当前没有满足条件的已确认可穿单品。"] };

    const order = catOrder();
    const pools = {};
    for (const cat of order) {
      const inCat = available.filter((item) => item.category === cat);
      const preferred = inCat.filter((item) => !isLowPriority(item));
      pools[cat] = (preferred.length ? preferred : inCat).sort(
        (a, b) => itemScore(b, occasion, temp) - itemScore(a, occasion, temp) || a.id.localeCompare(b.id)
      );
    }
    const bases = [];
    for (const top of pools.top || []) for (const bottom of pools.bottom || []) bases.push([top, bottom]);
    if (!bases.length) {
      general.push("缺少已确认可穿的上衣或下装，无法组成完整搭配。");
      return { outfits: [], general };
    }
    if (!(pools.shoes && pools.shoes.length)) general.push("缺少已确认可穿的鞋，方案可能不完整。");
    const shoes = pools.shoes && pools.shoes.length ? pools.shoes : [null];
    const tempCfg = (state.data.scoring && state.data.scoring.temp) || { cool: 20 };
    const needOuter = temp !== null && temp < tempCfg.cool;
    const outers = needOuter && pools.outerwear && pools.outerwear.length ? pools.outerwear : [null];
    if (needOuter && !(pools.outerwear && pools.outerwear.length)) general.push("按气温应检查外套，但没有满足条件的可用外套。");
    if (temp === null) general.push("未填写气温，不自动加外套，也不推断天气。");

    const candidates = [];
    for (const base of bases) {
      for (const shoe of shoes) {
        for (const outer of outers) {
          const picked = [...base, shoe, outer].filter(Boolean);
          const extras = (pools.accessory || []).filter((item) => !picked.some((chosen) => chosen.id === item.id));
          extras.sort(
            (a, b) =>
              itemScore(b, occasion, temp) +
                colorScore([...picked, b]) -
                (itemScore(a, occasion, temp) + colorScore([...picked, a])) || a.id.localeCompare(b.id)
          );
          if (extras[0]) picked.push(extras[0]);
          picked.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.id.localeCompare(b.id));
          const score = picked.reduce((sum, item) => sum + itemScore(item, occasion, temp), 0) + colorScore(picked);
          candidates.push({
            id: outfitId(picked),
            items: picked,
            score: Math.round(score * 10) / 10,
            warnings: buildWarnings(picked, occasion, temp),
          });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const selected = [];
    const seen = new Set();
    const seenTops = new Set();
    for (const candidate of candidates) {
      const key = coreKey(candidate.items);
      if (seen.has(key)) continue;
      const top = candidate.items.find((entry) => entry.category === "top");
      if (top && seenTops.has(top.id)) continue;
      selected.push(candidate);
      seen.add(key);
      if (top) seenTops.add(top.id);
      if (selected.length === 2) break;
    }
    if (!selected.length) general.push("当前条件无法形成完整搭配。");
    return { outfits: selected, general };
  }

  function thumb(item, className) {
    if (item.image) {
      return `<img class="${className}" src="${esc(item.image)}" alt="${esc(item.name)}，${esc(item.image_kind || "")}" loading="lazy">`;
    }
    return `<div class="thumb-empty">暂无商品图（${esc(item.image_kind || "待补")}）</div>`;
  }

  function badges(item) {
    const bits = [`<span class="badge ${esc(toneOf(item.status))}">${esc(statusLabel(item.status))}</span>`];
    if (item.lookalike) {
      const kind = item.image_kind && item.image_kind.indexOf("同款") >= 0 ? item.image_kind : "同款候选，非已核同一件";
      bits.push(`<span class="badge warning">${esc(kind)}</span>`);
    }
    if (isLowPriority(item) && item.status === "可穿") {
      bits.push(`<span class="badge neutral">可穿·不优先</span>`);
    }
    if (item.status === "已购·仅记录") bits.push(`<span class="badge neutral">记录项·不参与搭配</span>`);
    return `<div class="badge-row">${bits.join("")}</div>`;
  }

  function renderItemCard(item) {
    const selected = state.picked === item.id;
    return `<button type="button" class="item-card" data-item="${esc(item.id)}" aria-pressed="${selected ? "true" : "false"}">
      ${thumb(item, "thumb")}
      <div class="body">
        ${badges(item)}
        <h3>${esc(item.name)}</h3>
        <div class="sub">${esc(catLabel(item.category))}${item.color ? " · " + esc(colorLabel(item.color)) : ""}${item.brand ? " · " + esc(item.brand) : ""}</div>
        <div class="src">来源 ${item.sources && item.sources.length ? esc(item.sources.join("、")) : "未标明平台"} · 主图 ${esc(item.image_kind || "未标明")}</div>
      </div>
    </button>`;
  }

  function filteredItems(includeCulled) {
    const q = (state.query || "").trim().toLowerCase();
    return (state.data.items || []).filter((item) => {
      if (!includeCulled && item.status === "已淘汰/不常穿") return false;
      if (includeCulled && item.status !== "已淘汰/不常穿") return false;
      if (state.cat !== "all" && item.category !== state.cat) return false;
      if (!includeCulled) {
        if (state.statusFilter === "wearable" && item.status !== "可穿") return false;
        if (state.statusFilter === "record" && item.status !== "已购·仅记录") return false;
        if (state.statusFilter === "womens" && item.status !== "女款待核") return false;
        if (state.statusFilter === "all" && item.status === "已淘汰/不常穿") return false;
      }
      if (state.source !== "all") {
        if (state.source === "none") {
          if (item.sources && item.sources.length) return false;
        } else if (!(item.sources || []).includes(state.source)) return false;
      }
      if (q) {
        const blob = [item.name, item.brand, item.note, item.retire_reason, item.image_kind, (item.sources || []).join(" ")]
          .join(" ")
          .toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }

  function renderOutfit(outfit, index) {
    const title = "方案 " + (index + 1);
    const pieces = outfit.items
      .map((item) => {
        return `<div class="outfit-piece">
          ${item.image ? `<img src="${esc(item.image)}" alt="${esc(item.name)}，${esc(item.image_kind || "")}">` : `<div class="thumb-empty">${esc(item.image_kind || "暂无图")}</div>`}
          <div class="name">${esc(catLabel(item.category))}：${esc(item.name)}</div>
          <div class="src">${esc(item.image_kind || "")}${item.lookalike ? " · 主图为同款参考或同款候选，不是已核同一件" : ""}</div>
        </div>`;
      })
      .join("");
    const placeholder = state.data.tryon_placeholder || "AI 上身预览需用户私下提供照片，不公开。";
    const warnings = (outfit.warnings || []).map((w) => `<p class="warn">${esc(w)}</p>`).join("");
    return `<div class="outfit">
      <h3>${esc(title)}</h3>
      <div class="outfit-row">
        ${pieces}
        <div class="tryon-slot">
          <div class="box">${esc(placeholder)}</div>
          <div class="name">AI 上身预览</div>
        </div>
      </div>
      ${warnings}
    </div>`;
  }

  function render() {
    const data = state.data;
    const counts = data.counts || {};
    const links = data.links || {};
    const prefs = data.preferences || {};
    const selected = state.picked ? itemById(state.picked) : null;
    const temp = parseTemp();
    const suggestion = state.generated ? recommendOutfits(state.occasion, temp) : null;
    const gridItems = filteredItems(false);
    const culledItems = filteredItems(true);

    const occasionOptions = (data.occasions || [])
      .map((o) => `<option value="${esc(o.id)}"${o.id === state.occasion ? " selected" : ""}>${esc(o.label)}</option>`)
      .join("");
    const catChips = [{ id: "all", label: "全部分类" }]
      .concat(data.categories || [])
      .map(
        (c) =>
          `<button type="button" data-cat="${esc(c.id)}" aria-pressed="${state.cat === c.id ? "true" : "false"}">${esc(c.label)}</button>`
      )
      .join("");
    const statusChips = [
      { id: "wearable", label: "可穿" },
      { id: "record", label: "已购·仅记录" },
      { id: "womens", label: "女款待核" },
      { id: "all", label: "全部（不含已淘汰）" },
    ]
      .map(
        (s) =>
          `<button type="button" data-status="${esc(s.id)}" aria-pressed="${state.statusFilter === s.id ? "true" : "false"}">${esc(s.label)}</button>`
      )
      .join("");
    const sourceChips = [{ id: "all", label: "全部来源" }, { id: "京东", label: "京东" }, { id: "淘宝", label: "淘宝" }, { id: "得物", label: "得物" }, { id: "免税店", label: "免税店" }, { id: "其他", label: "其他" }, { id: "none", label: "未标明平台" }]
      .map(
        (s) =>
          `<button type="button" data-source="${esc(s.id)}" aria-pressed="${state.source === s.id ? "true" : "false"}">${esc(s.label)}</button>`
      )
      .join("");

    const rules = (prefs.rules || []).map((r) => `<li>${esc(r)}</li>`).join("");

    root.innerHTML = `
      <div class="wrap">
        <header class="hero">
          <h1>${esc(data.title || "我的衣橱")}</h1>
          <p class="summary">${esc(data.summary || "")}</p>
          <div class="meta-row">
            <span>更新于 ${esc(data.last_updated || "")}</span>
            ${links.raw ? `<a href="${esc(links.raw)}">原始数据</a>` : ""}
            ${links.repo ? `<a href="${esc(links.repo)}">GitHub 仓库</a>` : ""}
          </div>
        </header>

        <div class="sticky-controls">
          <div class="seg" role="tablist">
            <button type="button" data-tab="suggest" aria-pressed="${state.tab === "suggest" ? "true" : "false"}">搭配</button>
            <button type="button" data-tab="grid" aria-pressed="${state.tab === "grid" ? "true" : "false"}">衣橱</button>
          </div>
        </div>

        <div class="metrics four">
          <div class="metric"><b>${esc(counts.total || 0)}</b><span>全部单品</span></div>
          <div class="metric success"><b>${esc(counts.wearable || 0)}</b><span>可穿，可搭配</span></div>
          <div class="metric"><b>${esc(counts.record || 0)}</b><span>已购·仅记录</span></div>
          <div class="metric warning"><b>${esc(counts.retired || 0)}</b><span>已淘汰/不常穿</span></div>
        </div>

        <section class="block">
          <h2>穿着偏好</h2>
          <p class="caption">${esc(data.one_liner || "")}</p>
          <div class="callout info">
            <p class="lead">${esc(prefs.text || "")}</p>
            <ul>${rules}</ul>
          </div>
        </section>

        ${
          state.tab === "suggest"
            ? `<section class="block">
                <h2>按场合生成搭配</h2>
                <p class="caption">只使用已确认可穿的单品。已购·仅记录、已淘汰/不常穿和女款不进入方案。不穿乐福鞋；避开深咖色，其他棕或卡其可用。</p>
                <div class="controls-row">
                  <label>场合
                    <select id="occasion">${occasionOptions}</select>
                  </label>
                  <label>气温（℃，可空）
                    <input id="temp" type="number" inputmode="numeric" placeholder="选填" value="${esc(state.tempText)}">
                  </label>
                  <button type="button" class="primary" id="generate">生成搭配</button>
                </div>
                ${
                  suggestion
                    ? `${(suggestion.general || []).map((g) => `<div class="callout warning" style="margin-top:1rem"><p>${esc(g)}</p></div>`).join("")}
                       ${suggestion.outfits.map((outfit, i) => renderOutfit(outfit, i)).join("") || ""}`
                    : `<p class="caption" style="margin-top:1rem">选好场合后点「生成搭配」。公开页不展示本人上身照片。</p>`
                }
              </section>`
            : `<section class="block">
                <h2>单品列表</h2>
                <p class="caption">正在显示 ${gridItems.length} 件。可穿 ${esc(counts.wearable || 0)} 件，已购·仅记录 ${esc(counts.record || 0)} 件，已淘汰/不常穿 ${esc(counts.retired || 0)} 件，女款待核 ${esc(counts.womens || 0)} 件。点开卡片可看备注。</p>
                <div class="controls-row">
                  <input id="query" type="search" placeholder="搜索名称、品牌或备注" value="${esc(state.query)}">
                </div>
                <div class="chips" id="cat-chips">${catChips}</div>
                <div class="chips" id="status-chips">${statusChips}</div>
                <div class="chips" id="source-chips">${sourceChips}</div>
                <div class="grid">${gridItems.map(renderItemCard).join("") || `<p class="caption">没有符合筛选的单品。</p>`}</div>
                ${
                  selected && selected.status !== "已淘汰/不常穿"
                    ? `<div class="detail" style="margin-top:1rem">
                        ${selected.image ? `<img class="big" src="${esc(selected.image)}" alt="${esc(selected.name)}，${esc(selected.image_kind || "")}">` : `<div class="thumb-empty">暂无商品图（${esc(selected.image_kind || "待补")}）</div>`}
                        <div>
                          ${badges(selected)}
                          <h2 style="margin-top:0.5rem">${esc(selected.name)}</h2>
                          <p class="meta">${esc(catLabel(selected.category))}${selected.brand ? " · " + esc(selected.brand) : ""}${selected.color ? " · " + esc(colorLabel(selected.color)) : ""}</p>
                          <p class="meta">来源 ${selected.sources && selected.sources.length ? esc(selected.sources.join("、")) : "未标明平台"} · 主图 ${esc(selected.image_kind || "未标明")}</p>
                          ${selected.lookalike ? `<div style="margin-top:8px"><span class="badge warning">主图为同款参考或同款候选，不能当成已经核对过的同一件</span></div>` : ""}
                          <p style="margin:0.7rem 0 0">${esc(selected.note || "无更多备注。")}</p>
                        </div>
                      </div>`
                    : ""
                }
                <button type="button" class="quiet" id="toggle-culled">${state.showCulled ? "收起" : "展开"}已淘汰/不常穿（可恢复）· ${esc(counts.retired || 0)} 件</button>
                ${
                  state.showCulled
                    ? `<div class="grid" style="margin-top:0.9rem">${culledItems.map(renderItemCard).join("")}</div>
                       ${
                         selected && selected.status === "已淘汰/不常穿"
                           ? `<div class="detail" style="margin-top:1rem">
                               ${selected.image ? `<img class="big" src="${esc(selected.image)}" alt="${esc(selected.name)}，${esc(selected.image_kind || "")}">` : `<div class="thumb-empty">暂无商品图</div>`}
                               <div>
                                 ${badges(selected)}
                                 <h2 style="margin-top:0.5rem">${esc(selected.name)}</h2>
                                 <p class="meta">${esc(catLabel(selected.category))}${selected.brand ? " · " + esc(selected.brand) : ""}</p>
                                 ${selected.retire_reason ? `<p style="margin:0.7rem 0 0">淘汰原因：${esc(selected.retire_reason)}</p>` : ""}
                                 <p style="margin:0.7rem 0 0">${esc(selected.note || "")}</p>
                               </div>
                             </div>`
                           : ""
                       }`
                    : ""
                }
              </section>`
        }

        <p class="footer-links">
          ${esc(data.privacy || "")}<br>
          ${esc(data.disclaimer || "")}<br>
          ${links.pages ? `<a href="${esc(links.pages)}">在线页面</a> · ` : ""}
          ${links.raw ? `<a href="${esc(links.raw)}">data.json</a> · ` : ""}
          ${links.repo ? `<a href="${esc(links.repo)}">仓库</a> · ` : ""}
          ${links.ai_instructions ? `<a href="${esc(links.ai_instructions)}">给 AI 的说明</a>` : ""}
        </p>
      </div>
      <button type="button" class="top-btn" id="to-top">回到顶部</button>
    `;

    bind();
  }

  function bind() {
    root.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tab = btn.getAttribute("data-tab");
        render();
      });
    });
    const occasion = document.getElementById("occasion");
    if (occasion) {
      occasion.addEventListener("change", (e) => {
        state.occasion = e.target.value;
      });
    }
    const temp = document.getElementById("temp");
    if (temp) {
      temp.addEventListener("input", (e) => {
        state.tempText = e.target.value;
      });
    }
    const generate = document.getElementById("generate");
    if (generate) {
      generate.addEventListener("click", () => {
        state.generated = true;
        render();
      });
    }
    const query = document.getElementById("query");
    if (query) {
      query.addEventListener("input", (e) => {
        state.query = e.target.value;
        render();
        const again = document.getElementById("query");
        if (again) {
          again.focus();
          const len = again.value.length;
          again.setSelectionRange(len, len);
        }
      });
    }
    const catChips = document.getElementById("cat-chips");
    if (catChips) {
      catChips.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-cat]");
        if (!btn) return;
        state.cat = btn.getAttribute("data-cat");
        render();
      });
    }
    const statusChips = document.getElementById("status-chips");
    if (statusChips) {
      statusChips.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-status]");
        if (!btn) return;
        state.statusFilter = btn.getAttribute("data-status");
        render();
      });
    }
    const sourceChips = document.getElementById("source-chips");
    if (sourceChips) {
      sourceChips.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-source]");
        if (!btn) return;
        state.source = btn.getAttribute("data-source");
        render();
      });
    }
    root.querySelectorAll("[data-item]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-item");
        state.picked = state.picked === id ? null : id;
        render();
      });
    });
    const toggle = document.getElementById("toggle-culled");
    if (toggle) {
      toggle.addEventListener("click", () => {
        state.showCulled = !state.showCulled;
        render();
      });
    }
    const top = document.getElementById("to-top");
    if (top) top.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function bootError(msg) {
    root.innerHTML = `<p class="error">${esc(msg)}</p>`;
  }

  fetch("data.json", { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error("无法读取 data.json（" + res.status + "）");
      return res.json();
    })
    .then((data) => {
      state.data = data;
      const def = data.scoring && data.scoring.default_temp;
      state.tempText = def == null ? "" : String(def);
      render();
    })
    .catch((err) => {
      bootError("加载失败：" + (err && err.message ? err.message : err) + "。请通过网页服务器打开，或检查 data.json。");
    });
})();

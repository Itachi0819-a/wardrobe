(function () {
  var Logic = window.WardrobeLogic;
  var root = document.getElementById("app");

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bootError(msg) {
    if (!root) return;
    root.innerHTML = '<p class="error">' + esc(msg) + "</p>";
  }

  if (!root) return;
  if (!Logic) {
    bootError("页面脚本不完整，缺少 logic.js。");
    return;
  }

  var state = {
    data: null,
    items: [],
    counts: null,
    local: Logic.emptyLocal(),
    storageError: "",
    tab: "suggest",
    occasion: "daily",
    tempText: "",
    withAccessory: false,
    generated: false,
    cat: "all",
    statusFilter: "wearable",
    source: "all",
    query: "",
    picked: null,
    showCulled: false,
    importPreview: null,
    importError: "",
    restoreArmed: false,
    armRemove: "",
    forceTop: false,
    pendingScroll: ""
  };

  root.addEventListener("error", function (event) {
    var target = event.target;
    if (!target || target.tagName !== "IMG") return;
    var box = document.createElement("div");
    box.className = target.classList.contains("big") ? "big thumb-empty" : "thumb thumb-empty";
    box.textContent = "图片没有加载出来。没有用其他图片代替。";
    target.replaceWith(box);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.picked) {
      state.picked = null;
      state.armRemove = "";
      render();
    }
  });

  function statusIds() {
    return (state.data.statuses || []).map(function (row) { return row.id; });
  }

  function recompute() {
    state.items = Logic.mergeCatalog(state.data.items || [], state.local, statusIds());
    state.counts = Logic.countsOf(state.items);
  }

  function persist() {
    var result = Logic.writeLocal(window.localStorage, state.local);
    state.storageError = result.ok ? "" : result.error;
    return result.ok;
  }

  function publicItem(id) {
    return (state.data.items || []).find(function (item) { return item.id === id; }) || null;
  }

  function itemById(id) {
    return state.items.find(function (item) { return item.id === id; }) || null;
  }

  function capture() {
    var active = document.activeElement;
    function left(id) {
      var el = document.getElementById(id);
      return el ? el.scrollLeft : 0;
    }
    return {
      page: window.scrollY || 0,
      cat: left("cat-chips"),
      status: left("status-chips"),
      source: left("source-chips"),
      focus: active && active.id,
      sel: active && typeof active.selectionStart === "number" ? active.selectionStart : null
    };
  }

  function restore(snap) {
    var cat = document.getElementById("cat-chips");
    var status = document.getElementById("status-chips");
    var source = document.getElementById("source-chips");
    if (cat) cat.scrollLeft = snap.cat || 0;
    if (status) status.scrollLeft = snap.status || 0;
    if (source) source.scrollLeft = snap.source || 0;
    if (state.forceTop) {
      state.forceTop = false;
      window.scrollTo(0, 0);
    } else {
      window.scrollTo(0, snap.page || 0);
    }
    if (snap.focus === "query" || snap.focus === "temp" || snap.focus === "occasion") {
      var field = document.getElementById(snap.focus);
      if (field) {
        field.focus();
        if (snap.sel != null && field.setSelectionRange) {
          var pos = Math.min(snap.sel, field.value.length);
          field.setSelectionRange(pos, pos);
        }
      }
    }
    if (state.pendingScroll) {
      var target = document.getElementById(state.pendingScroll);
      state.pendingScroll = "";
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "start" });
    }
  }

  function toneOf(status) {
    var found = (state.data.statuses || []).find(function (row) { return row.id === status; });
    return found ? found.tone : "neutral";
  }

  function thumb(item, large) {
    var src = Logic.safeImage(item.image);
    var kind = item.image_kind ? "（" + esc(item.image_kind) + "）" : "";
    if (!src) return '<div class="' + (large ? "big " : "thumb ") + 'thumb-empty">暂无商品图' + kind + "</div>";
    var cls = large ? "big" : "thumb";
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="' + esc(item.name) + "，" + esc(item.image_kind || "商品图") + '" loading="lazy" decoding="async">';
  }

  function badges(item, dup) {
    var bits = ['<span class="badge ' + esc(toneOf(item.status)) + '">' + esc(Logic.labelOf(state.data.statuses, item.status, item.status)) + "</span>"];
    if (item.lookalike) {
      var kind = item.image_kind && item.image_kind.indexOf("同款") !== -1 ? item.image_kind : "同款候选，非已核同一件";
      bits.push('<span class="badge warning">' + esc(kind) + "</span>");
    }
    if (item.low_priority && item.status === "可穿") bits.push('<span class="badge neutral">可穿·不优先</span>');
    if (item.status === "已购·仅记录") bits.push('<span class="badge neutral">不参与搭配</span>');
    if (dup && dup.retiredTwin && item.status === "可穿") bits.push('<span class="badge danger">同款号已有淘汰记录，搭配跳过</span>');
    else if (dup) bits.push('<span class="badge warning">可能是重复记录</span>');
    if (state.local.overrides[item.id] && state.local.overrides[item.id].status) bits.push('<span class="badge accent">本机状态</span>');
    if (!publicItem(item.id)) bits.push('<span class="badge accent">本机新增</span>');
    return '<div class="badge-row">' + bits.join("") + "</div>";
  }

  function renderCard(item, dup) {
    var selected = state.picked === item.id;
    var sub = [Logic.labelOf(state.data.categories, item.category, item.category)];
    if (item.color) sub.push(Logic.labelOf(state.data.colors, item.color, item.color));
    if (item.brand) sub.push(item.brand);
    return '<button type="button" class="item-card" data-item="' + esc(item.id) + '" aria-pressed="' + (selected ? "true" : "false") + '">' +
      thumb(item, false) +
      '<span class="body">' + badges(item, dup) +
      "<h3>" + esc(item.name) + "</h3>" +
      '<span class="sub">' + esc(sub.join(" · ")) + "</span>" +
      '<span class="src">来源 ' + esc(item.sources && item.sources.length ? item.sources.join("、") : "未标明平台") + " · 主图 " + esc(item.image_kind || "未标明") + "</span>" +
      "</span></button>";
  }

  function detail(item, dup) {
    if (!item) return "";
    var pub = publicItem(item.id);
    var lines = [];
    if (pub && state.local.overrides[item.id] && state.local.overrides[item.id].status) {
      lines.push("公开清单里是「" + pub.status + "」。当前这台设备上是「" + item.status + "」，没有写回公开仓库。");
    } else if (!pub) {
      lines.push("这件只在本机导入的数据里，不在公开清单中。");
    }
    if (isBlocked(item)) lines.push("名称里有乐福或深咖，即使标成可穿也不会进入搭配。");
    var actions = "";
    if (item.status === "可穿") {
      actions += '<button type="button" class="quiet" data-local-status="已淘汰/不常穿" data-id="' + esc(item.id) + '">仅在本机标为已淘汰</button>';
    } else if (item.status === "已淘汰/不常穿") {
      actions += '<button type="button" class="quiet" data-local-status="可穿" data-id="' + esc(item.id) + '">仅在本机恢复为可穿</button>';
    }
    if (pub && state.local.overrides[item.id] && state.local.overrides[item.id].status) {
      actions += '<button type="button" class="quiet" data-action="undo-status" data-id="' + esc(item.id) + '">撤销本机状态</button>';
    }
    if (!pub) {
      var armed = state.armRemove === item.id;
      actions += '<button type="button" class="quiet" data-action="remove-extra" data-id="' + esc(item.id) + '">' + (armed ? "再点一次，从本机移除" : "从本机新增里移除") + "</button>";
    }
    return '<div class="sheet" id="detail-sheet">' +
      '<div class="sheet-head"><h2 id="detail-title">' + esc(item.name) + '</h2><button type="button" class="quiet" data-action="close-detail">关闭</button></div>' +
      thumb(item, true) +
      badges(item, dup) +
      '<p class="meta">' + esc(Logic.labelOf(state.data.categories, item.category, item.category)) +
      (item.brand ? " · " + esc(item.brand) : "") +
      (item.color ? " · " + esc(Logic.labelOf(state.data.colors, item.color, item.color)) : "") + "</p>" +
      '<p class="meta">来源 ' + esc(item.sources && item.sources.length ? item.sources.join("、") : "未标明平台") + " · 主图 " + esc(item.image_kind || "未标明") + "</p>" +
      (item.lookalike ? '<p class="warn">主图是同款参考或同款候选，不能当成已经核对过的同一件。</p>' : "") +
      (item.retire_reason ? "<p>淘汰原因：" + esc(item.retire_reason) + "</p>" : "") +
      "<p>" + esc(item.note || "无更多备注。") + "</p>" +
      (lines.length ? '<p class="meta">' + esc(lines.join("")) + "</p>" : "") +
      '<div class="row-actions">' + actions + "</div></div>";
  }

  function isBlocked(item) {
    return Logic.isLoafer(item) || Logic.isDeepCoffee(item);
  }

  function outfitView(outfit) {
    var pieces = outfit.items.map(function (item) {
      var src = Logic.safeImage(item.image);
      var media = src
        ? '<img src="' + esc(src) + '" alt="' + esc(item.name) + "，" + esc(item.image_kind || "") + '" loading="lazy" decoding="async">'
        : '<div class="thumb-empty">' + esc(item.image_kind || "暂无商品图") + "</div>";
      return '<div class="outfit-piece">' + media +
        '<div class="name">' + esc(Logic.labelOf(state.data.categories, item.category, item.category)) + "：" + esc(item.name) + "</div>" +
        '<div class="src">' + esc(item.image_kind || "主图未标明") + (item.lookalike ? " · 不能当成已核同一件" : "") + "</div></div>";
    }).join("");
    var reasons = (outfit.reasons || []).map(function (reason) { return "<li>" + esc(reason) + "</li>"; }).join("");
    var warnings = (outfit.warnings || []).map(function (warning) { return '<p class="warn">' + esc(warning) + "</p>"; }).join("");
    return '<article class="outfit"><h3>' + esc(outfit.title) + "</h3>" +
      '<p class="caption">' + (outfit.role === "primary" ? "这一套是当前条件下更可执行的组合。" : "这是另一套不同上衣或连衣裙，用来替换，不是试穿过的第二名。") + "</p>" +
      '<div class="outfit-row">' + pieces +
      '<div class="tryon-slot"><div class="box">不能生成上身图，也不是模拟。</div><div class="name">没有上身预览</div></div></div>' +
      '<ul class="reasons">' + reasons + "</ul>" + warnings + "</article>";
  }

  function previewBlock() {
    var preview = state.importPreview;
    if (!preview && !state.importError) return "";
    if (state.importError) return '<div class="callout warning" role="alert"><p>' + esc(state.importError) + "</p></div>";
    function names(list) {
      return list.slice(0, 5).map(function (entry) { return entry.name || entry.id || entry.reason; }).join("、");
    }
    return '<div class="callout info"><p class="lead">导入预览，还没有写入</p><ul>' +
      "<li>读到 " + preview.incomingCount + " 条。</li>" +
      "<li>将新增 " + preview.added.length + " 件" + (preview.added.length ? "：" + esc(names(preview.added)) : "") + "。</li>" +
      "<li>只补空字段 " + preview.filled.length + " 件。已有名称、图片和状态不会被安全合并盖掉。</li>" +
      "<li>导入文件里状态不同的有 " + preview.statusChanges.length + " 件。只有点下面第二个按钮才会改本机状态。</li>" +
      "<li>文件里没有、但仍会保留的现有单品：" + preview.keptDespiteOmission + " 件。</li>" +
      "<li>拒绝 " + preview.rejected.length + " 条" + (preview.rejected.length ? "：" + esc(names(preview.rejected)) : "") + "。</li>" +
      "<li>丢弃的外链或不明图片：" + preview.imageDropped + " 处。没有拿别的图补上。</li>" +
      "</ul>" +
      '<div class="row-actions">' +
      '<button type="button" class="primary" data-action="apply-import" data-mode="safe">合并：只补新单品和空字段</button>' +
      '<button type="button" class="quiet" data-action="apply-import" data-mode="status">合并并采用导入的状态（仍不删除）</button>' +
      '<button type="button" class="quiet" data-action="cancel-import">取消这次导入</button></div></div>';
  }

  function render() {
    var snap = capture();
    var data = state.data;
    var dup = Logic.duplicateIndex(state.items);
    var links = data.links || {};
    var prefs = data.preferences || {};
    var suggestion = null;
    var suggestError = "";
    if (state.generated) {
      try {
        suggestion = Logic.recommendOutfits(data, state.items, {
          occasion: state.occasion,
          tempText: state.tempText,
          withAccessory: state.withAccessory
        });
      } catch (err) {
        suggestError = "搭配没有生成：" + (err && err.message ? err.message : err);
      }
    }
    var gridItems = Logic.filterItems(data, state.items, {
      query: state.query,
      category: state.cat,
      statusFilter: state.statusFilter,
      source: state.source,
      culledOnly: false
    });
    var culledItems = Logic.filterItems(data, state.items, {
      query: state.query,
      category: state.cat,
      source: state.source,
      culledOnly: true
    });
    var selected = state.picked ? itemById(state.picked) : null;
    var counts = state.counts || Logic.countsOf([]);
    var localNote = Logic.localIsEmpty(state.local) ? "" : "件数含本机修改，公开清单没有改。";
    var countWarn = Logic.localIsEmpty(state.local) && Logic.countsDiffer(Logic.countsOf(data.items || []), data.counts);

    function chip(attr, id, label, pressed) {
      return '<button type="button" data-' + attr + '="' + esc(id) + '" aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(label) + "</button>";
    }
    var occasionOptions = (data.occasions || []).map(function (row) {
      return '<option value="' + esc(row.id) + '"' + (row.id === state.occasion ? " selected" : "") + ">" + esc(row.label) + "</option>";
    }).join("");
    var catChips = [{ id: "all", label: "全部分类" }].concat(data.categories || []).map(function (row) {
      return chip("cat", row.id, row.label, state.cat === row.id);
    }).join("");
    var statusChips = [
      ["wearable", "可穿"],
      ["record", "已购·仅记录"],
      ["womens", "女款待核"],
      ["all", "全部（不含已淘汰）"]
    ].map(function (row) { return chip("status", row[0], row[1], state.statusFilter === row[0]); }).join("");
    var sourceChips = [
      ["all", "全部来源"],
      ["京东", "京东"],
      ["淘宝", "淘宝"],
      ["得物", "得物"],
      ["免税店", "免税店"],
      ["其他", "其他"],
      ["none", "未标明平台"]
    ].map(function (row) { return chip("source", row[0], row[1], state.source === row[0]); }).join("");
    var rules = (prefs.rules || []).map(function (rule) { return "<li>" + esc(rule) + "</li>"; }).join("");
    var catCount = {};
    gridItems.forEach(function (item) { catCount[item.category] = (catCount[item.category] || 0) + 1; });
    var catSummary = (data.categories || []).filter(function (row) { return catCount[row.id]; }).map(function (row) {
      return row.label + " " + catCount[row.id];
    }).join(" · ");

    var panel = "";
    if (state.tab === "suggest") {
      var resultHtml = '<p class="caption result-note">选好场合后点「生成搭配」。留空气温就不会假设今天冷热。公开页不能生成上身图。</p>';
      if (suggestError) resultHtml = '<div class="callout warning" role="alert"><p>' + esc(suggestError) + "</p></div>";
      else if (suggestion) {
        var notes = (suggestion.general || []).map(function (line) { return "<li>" + esc(line) + "</li>"; }).join("");
        var held = (suggestion.heldBack || []).map(function (entry) {
          return '<li><button type="button" class="text-button" data-held="' + esc(entry.id) + '">' + esc(entry.name) + "</button>：" + esc(entry.reason) + "</li>";
        }).join("");
        resultHtml = '<div id="results" aria-live="polite"><div class="callout info"><ul>' + notes + "</ul></div>" +
          suggestion.outfits.map(outfitView).join("") +
          (held ? '<div class="callout warning"><p class="lead">这些可穿记录没有自动搭配</p><ul>' + held + "</ul></div>" : "") +
          "</div>";
      }
      panel = '<section class="block" id="panel" role="tabpanel" aria-labelledby="tab-suggest"><h2>按场合生成搭配</h2>' +
        '<p class="caption">只用允许搭配、且名称或备注里没有乐福、深咖的单品。已购仅记录、已淘汰、女款不进入。不优先单品只在该类别没有其他可穿选择时使用。棕色和卡其不会因为「不太喜欢深咖」被排除。</p>' +
        '<div class="controls-row"><label for="occasion">场合 <select id="occasion">' + occasionOptions + "</select></label>" +
        '<label for="temp">气温（℃，可空） <input id="temp" type="number" inputmode="decimal" placeholder="不猜测" value="' + esc(state.tempText) + '"></label>' +
        '<label class="check" for="with-accessory"><input id="with-accessory" type="checkbox"' + (state.withAccessory ? " checked" : "") + "> 加入一件配饰</label>" +
        '<button type="button" class="primary" data-action="generate">生成搭配</button></div>' +
        '<p class="caption">配饰默认关闭。打开后也不会选光学镜；冬帽只在你填写的低温里考虑。参考气温 ' + esc(data.scoring && data.scoring.default_temp != null ? data.scoring.default_temp : "无") + "℃ 只写在清单里，不会自动填进上面。</p>" +
        resultHtml + "</section>";
    } else if (state.tab === "grid") {
      panel = '<section class="block" id="panel" role="tabpanel" aria-labelledby="tab-grid"><h2>单品列表</h2>' +
        '<p class="caption">正在显示 ' + gridItems.length + " 件" + (catSummary ? "（" + esc(catSummary) + "）" : "") + "。可穿 " + counts.wearable + "，已购·仅记录 " + counts.record + "，已淘汰/不常穿 " + counts.retired + "，女款待核 " + counts.womens + "。点卡片看备注。</p>" +
        '<div class="controls-row"><input id="query" type="search" enterkeyhint="search" placeholder="搜索名称、品牌、分类或备注" value="' + esc(state.query) + '"></div>' +
        '<div class="chips" id="cat-chips" role="group" aria-label="分类">' + catChips + "</div>" +
        '<div class="chips" id="status-chips" role="group" aria-label="状态">' + statusChips + "</div>" +
        '<div class="chips" id="source-chips" role="group" aria-label="来源">' + sourceChips + "</div>" +
        (selected ? detail(selected, dup.get(selected.id)) : "") +
        '<div class="grid">' + (gridItems.map(function (item) { return renderCard(item, dup.get(item.id)); }).join("") || '<p class="caption">没有符合筛选的单品。可以清空搜索或改筛选。已淘汰的在下面单独展开，没有被删除。</p>') + "</div>" +
        '<button type="button" class="quiet" data-action="toggle-culled" aria-expanded="' + (state.showCulled ? "true" : "false") + '">' + (state.showCulled ? "收起" : "展开") + "已淘汰/不常穿（可恢复）· " + counts.retired + " 件</button>" +
        (state.showCulled
          ? '<div class="grid grid-gap">' + (culledItems.map(function (item) { return renderCard(item, dup.get(item.id)); }).join("") || '<p class="caption">已淘汰分组里没有符合当前搜索和分类的单品。分组还在，没有删除。</p>') + "</div>"
          : "") +
        "</section>";
    } else {
      panel = '<section class="block" id="panel" role="tabpanel" aria-labelledby="tab-data"><h2>本机数据</h2>' +
        '<p class="caption">公开清单来自 data.json。这里的修改只留在这台设备，不会上传，也不会改 GitHub 上的文件。不要把本人照片、尺码、身高体重、电话或订单号导入进来。</p>' +
        (state.storageError ? '<div class="callout warning" role="alert"><p>' + esc(state.storageError) + "</p></div>" : "") +
        '<div class="row-actions"><button type="button" class="primary" data-action="export">导出当前衣橱</button></div>' +
        '<div class="row-actions"><button type="button" class="primary" data-action="pick-file">选择 JSON 文件</button></div>' +
        '<input id="import-file" class="sr-only" type="file" accept="application/json,.json">' +
        previewBlock() +
        '<div class="callout"><p class="lead">恢复公开清单</p><p>会清掉这台设备上的状态修改和导入。公开仓库不受影响。清掉之前可以先导出。</p>' +
        '<label class="check" for="restore-arm"><input id="restore-arm" type="checkbox"' + (state.restoreArmed ? " checked" : "") + "> 我确认清除本机修改</label>" +
        '<button type="button" class="quiet" data-action="restore"' + (state.restoreArmed ? "" : " disabled") + ">清除本机修改并恢复公开清单</button></div></section>";
    }

    function link(url, label) {
      var safe = Logic.safeHttpUrl(url);
      return safe ? '<a href="' + esc(safe) + '">' + esc(label) + "</a>" : "";
    }

    root.innerHTML = '<a class="skip" href="#panel">跳到内容</a><div class="wrap">' +
      '<header class="hero"><h1>' + esc(data.title || "我的衣橱") + "</h1>" +
      '<p class="summary">' + esc(data.summary || "") + "</p>" +
      '<p class="one-liner">' + esc(data.one_liner || "") + "</p>" +
      '<div class="meta-row"><span>页面 ' + esc(data.last_updated || "") + "</span>" +
      '<span>清单核对 ' + esc(data.data_as_of || "") + "</span>" +
      link(links.raw, "原始数据") + link(links.repo, "GitHub 仓库") + "</div></header>" +
      '<div class="sticky-controls"><div class="seg" role="tablist" aria-label="衣橱分页">' +
      '<button type="button" id="tab-suggest" role="tab" data-tab="suggest" aria-selected="' + (state.tab === "suggest" ? "true" : "false") + '" aria-controls="panel">搭配</button>' +
      '<button type="button" id="tab-grid" role="tab" data-tab="grid" aria-selected="' + (state.tab === "grid" ? "true" : "false") + '" aria-controls="panel">衣橱</button>' +
      '<button type="button" id="tab-data" role="tab" data-tab="data" aria-selected="' + (state.tab === "data" ? "true" : "false") + '" aria-controls="panel">本机</button>' +
      "</div></div>" +
      '<div class="metrics four">' +
      '<div class="metric"><b>' + counts.total + "</b><span>全部单品</span></div>" +
      '<div class="metric success"><b>' + counts.wearable + "</b><span>状态为可穿</span></div>" +
      '<div class="metric"><b>' + counts.record + "</b><span>已购·仅记录</span></div>" +
      '<div class="metric warning"><b>' + counts.retired + "</b><span>已淘汰/不常穿</span></div></div>" +
      (localNote ? '<p class="caption local-note">' + esc(localNote) + "</p>" : "") +
      (countWarn ? '<p class="warn">清单里的 counts 和单品数量不一致。页面数字按单品现算。</p>' : "") +
      '<details class="block prefs"><summary>穿着偏好和整理规则</summary>' +
      '<div class="callout info"><p class="lead">' + esc(prefs.text || "") + "</p><ul>" + rules + "</ul></div></details>" +
      panel +
      '<p class="footer-links">' + esc(data.privacy || "") + "<br>" + esc(data.disclaimer || "") + "<br>" +
      [link(links.pages, "在线页面"), link(links.raw, "data.json"), link(links.repo, "仓库"), link(links.ai_instructions, "给 AI 的说明")].filter(Boolean).join(" · ") +
      "</p></div>" +
      '<button type="button" class="top-btn" data-action="top">回到顶部</button>';

    document.body.classList.toggle("has-sheet", state.tab === "grid" && !!selected);
    document.body.classList.toggle("tab-suggest", state.tab === "suggest");
    restore(snap);
  }

  function setStatus(id, status) {
    var pub = publicItem(id);
    if (pub) {
      if (!state.local.overrides[id]) state.local.overrides[id] = {};
      if (status === pub.status) {
        delete state.local.overrides[id].status;
        delete state.local.overrides[id].retire_reason;
        if (!state.local.overrides[id].fill) delete state.local.overrides[id];
      } else {
        state.local.overrides[id].status = status;
        if (status === "已淘汰/不常穿") state.local.overrides[id].retire_reason = "仅在本机标为已淘汰/不常穿，未写入公开清单。";
      }
    } else {
      var extra = (state.local.extraItems || []).find(function (item) { return item.id === id; });
      if (!extra) return;
      extra.status = status;
      if (status === "已淘汰/不常穿") extra.retire_reason = "仅在本机标为已淘汰/不常穿，未写入公开清单。";
    }
    persist();
    recompute();
    render();
  }

  root.addEventListener("click", function (event) {
    var target = event.target.closest("button, a");
    if (!target || !root.contains(target)) return;
    if (target.hasAttribute("data-tab")) {
      state.tab = target.getAttribute("data-tab");
      state.forceTop = true;
      render();
      return;
    }
    if (target.hasAttribute("data-cat")) {
      state.cat = target.getAttribute("data-cat");
      render();
      return;
    }
    if (target.hasAttribute("data-status")) {
      state.statusFilter = target.getAttribute("data-status");
      render();
      return;
    }
    if (target.hasAttribute("data-source")) {
      state.source = target.getAttribute("data-source");
      render();
      return;
    }
    if (target.hasAttribute("data-item")) {
      var id = target.getAttribute("data-item");
      state.picked = state.picked === id ? null : id;
      state.armRemove = "";
      render();
      return;
    }
    if (target.hasAttribute("data-held")) {
      state.tab = "grid";
      state.picked = target.getAttribute("data-held");
      state.statusFilter = "wearable";
      state.forceTop = true;
      render();
      return;
    }
    if (target.hasAttribute("data-local-status")) {
      setStatus(target.getAttribute("data-id"), target.getAttribute("data-local-status"));
      return;
    }
    var action = target.getAttribute("data-action");
    if (action === "generate") {
      state.generated = true;
      state.pendingScroll = "results";
      render();
    } else if (action === "toggle-culled") {
      state.showCulled = !state.showCulled;
      render();
    } else if (action === "close-detail") {
      state.picked = null;
      state.armRemove = "";
      render();
    } else if (action === "undo-status") {
      setStatus(target.getAttribute("data-id"), (publicItem(target.getAttribute("data-id")) || {}).status);
    } else if (action === "remove-extra") {
      var extraId = target.getAttribute("data-id");
      if (state.armRemove !== extraId) {
        state.armRemove = extraId;
        render();
        return;
      }
      state.local.extraItems = (state.local.extraItems || []).filter(function (item) { return item.id !== extraId; });
      delete state.local.overrides[extraId];
      state.armRemove = "";
      state.picked = null;
      persist();
      recompute();
      render();
    } else if (action === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "pick-file") {
      var picker = document.getElementById("import-file");
      if (picker) picker.click();
    } else if (action === "export") {
      var payload = {
        exported_from: "wardrobe-local",
        notice: "可能含本机修改。不要把个人照片、尺码、身高体重、电话或订单号写进公开仓库。",
        items: state.items
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "wardrobe-backup.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } else if (action === "apply-import" && state.importPreview) {
      var next = target.getAttribute("data-mode") === "status" ? state.importPreview.statusNext : state.importPreview.safeNext;
      state.local = next;
      persist();
      state.importPreview = null;
      recompute();
      render();
    } else if (action === "cancel-import") {
      state.importPreview = null;
      state.importError = "";
      render();
    } else if (action === "restore") {
      if (!state.restoreArmed) return;
      var cleared = Logic.emptyLocal();
      var wrote = Logic.writeLocal(window.localStorage, cleared);
      if (!wrote.ok) {
        state.storageError = wrote.error + " 本机备份没有被清掉。";
        render();
        return;
      }
      state.local = cleared;
      state.storageError = "";
      state.restoreArmed = false;
      state.importPreview = null;
      state.picked = null;
      recompute();
      render();
    }
  });

  root.addEventListener("compositionend", function (event) {
    if (event.target.id === "query") {
      state.query = event.target.value;
      render();
    }
  });

  root.addEventListener("input", function (event) {
    if (event.target.id === "query") {
      if (event.isComposing) return;
      state.query = event.target.value;
      render();
    } else if (event.target.id === "temp") {
      state.tempText = event.target.value;
      render();
    }
  });

  root.addEventListener("change", function (event) {
    if (event.target.id === "occasion") {
      state.occasion = event.target.value;
      render();
    } else if (event.target.id === "with-accessory") {
      state.withAccessory = !!event.target.checked;
      render();
    } else if (event.target.id === "restore-arm") {
      state.restoreArmed = !!event.target.checked;
      render();
    } else if (event.target.id === "import-file") {
      var file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var result = Logic.previewMerge(state.data, state.data.items, state.local, String(reader.result || ""));
        if (!result.ok) {
          state.importError = result.error;
          state.importPreview = null;
        } else {
          state.importError = "";
          state.importPreview = result.preview;
        }
        render();
      };
      reader.onerror = function () {
        state.importError = "文件没有读出来，衣橱没有改动。";
        state.importPreview = null;
        render();
      };
      reader.readAsText(file, "utf-8");
    }
  });

  fetch("data.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("无法读取 data.json（" + res.status + "）");
      return res.json();
    })
    .then(function (data) {
      state.data = data;
      document.title = data.title || "我的衣橱";
      var stored = Logic.readLocal(window.localStorage);
      state.local = stored.state || Logic.emptyLocal();
      state.storageError = stored.ok ? "" : (stored.error || "");
      var cleaned = [];
      var dropped = 0;
      (state.local.extraItems || []).forEach(function (raw) {
        var result = Logic.sanitizeItem(data, raw);
        if (result.ok) cleaned.push(result.item);
        else dropped += 1;
      });
      state.local.extraItems = cleaned;
      if (dropped) {
        state.storageError = (state.storageError ? state.storageError + " " : "") + "有 " + dropped + " 件本机新增无法识别，没有放进衣橱。";
        persist();
      }
      state.tempText = Logic.initialTempText(data);
      if ((data.occasions || []).every(function (row) { return row.id !== state.occasion; }) && data.occasions && data.occasions[0]) {
        state.occasion = data.occasions[0].id;
      }
      recompute();
      render();
    })
    .catch(function (err) {
      bootError("加载失败：" + (err && err.message ? err.message : err) + "。请通过网页服务器打开，或检查 data.json。");
    });
})();

/* Original ES5 Panorama client. Only authoritative server snapshots change skills. */
var ChronicleLabyrinthAbilityEditor = (function () {
  "use strict";
  var root = $.GetContextPanel();
  var REQUEST = "chronicle_labyrinth_ability_ui_request";
  var RESPONSE = "chronicle_labyrinth_ability_ui_state";
  var model = {
    skills: [],
    catalog: null,
    query: "",
    category: "default",
    page: 1,
    pageSize: 5,
    selected: null,
    pending: null,
    mutation: null,
    revision: -1,
    allowRisk: false,
    requests: {},
    latestCatalog: null,
    searchToken: 0,
    sequence: 0
  };
  var categories = {
    default: true,
    complex: true,
    all: true,
    hidden: true,
    talent: true,
    item: true,
    generic: true
  };

  function panel(id) {
    return root.FindChildTraverse(id);
  }
  function text(id, value) {
    var node = panel(id);
    if (node) node.text = String(value || "");
  }
  function boolean(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }
  function normalized(item) {
    var copy = {},
      key;
    for (key in item)
      if (Object.prototype.hasOwnProperty.call(item, key))
        copy[key] = item[key];
    copy.owned = boolean(item.owned);
    copy.readonly =
      item.readonly === undefined ? !copy.owned : boolean(item.readonly);
    copy.hidden = boolean(item.hidden);
    copy.active = boolean(item.active);
    copy.requiresRisk = boolean(item.requiresRisk);
    return copy;
  }
  function array(value) {
    if (!value) return [];
    if (Object.prototype.toString.call(value) === "[object Array]")
      return value;
    var keys = Object.keys(value).filter(function (key) {
      return /^\d+$/.test(key);
    });
    keys.sort(function (a, b) {
      return Number(a) - Number(b);
    });
    return keys.map(function (key) {
      return value[key];
    });
  }
  function localized(token, fallback) {
    var value;
    try {
      value = $.Localize(token);
    } catch (error) {
      value = "";
    }
    return value && value !== token && value !== token.replace(/^#/, "")
      ? value
      : fallback;
  }
  function abilityName(item) {
    return localized(
      item.localizationToken || "#DOTA_Tooltip_ability_" + item.name,
      item.localizedName || item.name
    );
  }
  function heroName(name) {
    return name
      ? localized("#" + name, name.replace(/^npc_dota_hero_/, ""))
      : "来源未确认";
  }
  function busy() {
    return !!model.mutation || !!model.pending;
  }
  function status(message, kind) {
    text("OperationStatus", message);
    panel("StatusBlock").SetHasClass("Error", kind === "error");
    panel("StatusBlock").SetHasClass("Pending", kind === "pending");
  }
  function request(action, values) {
    var id = "ui-" + ++model.sequence,
      payload = { requestId: id, action: action };
    var key;
    for (key in values)
      if (Object.prototype.hasOwnProperty.call(values, key))
        payload[key] = values[key];
    model.requests[id] = payload;
    if (action === "catalog") model.latestCatalog = id;
    if (action === "add" || action === "level" || action === "remove") {
      if (busy()) {
        delete model.requests[id];
        return;
      }
      model.mutation = id;
      status("等待服务器确认…", "pending");
      renderSkills();
      updateEnabled();
      $.Schedule(12, function () {
        if (model.mutation === id) {
          model.mutation = null;
          status("服务器响应超时，操作结果未确认。请刷新状态。", "error");
          updateEnabled();
        }
      });
    }
    GameEvents.SendCustomGameEventToServer(REQUEST, payload);
    return id;
  }
  function catalogRequest() {
    request("catalog", {
      query: model.query,
      category: model.category,
      page: model.page,
      pageSize: model.pageSize
    });
  }
  function skillRow(parent, item, readonly) {
    var row = $.CreatePanel("Panel", parent, ""),
      icon,
      copy,
      title,
      meta;
    row.AddClass("AbilityRow");
    icon = $.CreatePanel("DOTAAbilityImage", row, "");
    icon.AddClass("AbilityIcon");
    icon.abilityname = item.name;
    icon.hittest = false;
    copy = $.CreatePanel("Panel", row, "");
    copy.AddClass("AbilityCopy");
    copy.hittest = false;
    title = $.CreatePanel("Label", copy, "");
    title.AddClass("AbilityName");
    title.text = abilityName(item);
    meta = $.CreatePanel("Label", copy, "");
    meta.AddClass("AbilityMeta");
    meta.text = readonly
      ? "等级 " + item.level + " · 只读" + (item.hidden ? " · 隐藏" : "")
      : "等级 " +
        item.level +
        " / " +
        item.maxLevel +
        (item.hidden ? " · 隐藏" : "");
    if (!readonly) {
      actionButton(row, "−", item, Number(item.level) - 1, false);
      actionButton(row, "+", item, Number(item.level) + 1, false);
      actionButton(row, "×", item, null, true);
    }
  }
  function actionButton(parent, title, item, level, remove) {
    var button = $.CreatePanel("Button", parent, ""),
      label;
    button.AddClass("SkillAction");
    if (remove) button.AddClass("RemoveAction");
    button.enabled =
      !busy() &&
      item.owned === true &&
      !item.readonly &&
      (remove || (level >= 0 && level <= Number(item.maxLevel)));
    button.SetPanelEvent("onactivate", function () {
      if (busy() || !item.owned || item.readonly) return;
      request(
        remove ? "remove" : "level",
        remove ? { ability: item.name } : { ability: item.name, level: level }
      );
    });
    label = $.CreatePanel("Label", button, "");
    label.text = title;
    label.hittest = false;
  }
  function renderSkills() {
    var owned = panel("OwnedSkills"),
      native = panel("NativeSkills"),
      ownCount = 0,
      nativeCount = 0;
    owned.RemoveAndDeleteChildren();
    native.RemoveAndDeleteChildren();
    model.skills.forEach(function (item) {
      if (item.owned === true && !item.readonly) {
        skillRow(owned, item, false);
        ownCount++;
      } else {
        skillRow(native, item, true);
        nativeCount++;
      }
    });
    text("OwnedCount", ownCount + " 个");
    text("NativeSummary", "原技能与天赋 · " + nativeCount + " 项只读");
    panel("OwnedEmpty").visible = ownCount === 0;
  }
  function renderCatalog() {
    var list = panel("CatalogSkills"),
      catalog = model.catalog;
    list.RemoveAndDeleteChildren();
    if (!catalog) {
      panel("CatalogEmpty").visible = true;
      updateEnabled();
      return;
    }
    array(catalog.items).forEach(function (item) {
      var row = $.CreatePanel("Button", list, ""),
        icon,
        copy,
        title,
        meta;
      row.AddClass("AbilityRow");
      row.AddClass("CatalogRow");
      row.SetHasClass(
        "Selected",
        !!model.selected && model.selected.name === item.name
      );
      icon = $.CreatePanel("DOTAAbilityImage", row, "");
      icon.AddClass("AbilityIcon");
      icon.abilityname = item.name;
      icon.hittest = false;
      copy = $.CreatePanel("Panel", row, "");
      copy.AddClass("AbilityCopy");
      copy.hittest = false;
      title = $.CreatePanel("Label", copy, "");
      title.AddClass("AbilityName");
      title.text = abilityName(item);
      meta = $.CreatePanel("Label", copy, "");
      meta.AddClass("AbilityMeta");
      meta.text =
        heroName(item.sourceHero) +
        (item.requiresRisk ? " · 高级项目" : " · 效果待验证");
      row.SetPanelEvent("onactivate", function () {
        model.selected = item;
        model.allowRisk = false;
        panel("AllowRisk").checked = false;
        renderCatalog();
        renderSelected();
      });
    });
    panel("CatalogEmpty").visible = Number(catalog.total) === 0;
    text("CatalogEmpty", "没有匹配技能，请调整搜索或分类。");
    text("CatalogCount", catalog.total + " 项");
    text(
      "PageLabel",
      catalog.page +
        " / " +
        Math.max(1, Math.ceil(catalog.total / catalog.pageSize))
    );
    updateEnabled();
  }
  function renderSelected() {
    var item = model.selected;
    text("SelectedName", item ? abilityName(item) : "选择一个技能");
    text("SelectedInternal", item ? item.name : "");
    text(
      "DependencyNote",
      item
        ? item.dependencyNote || "技能效果与声音、粒子需实际试玩验证。"
        : "添加不等于完整效果兼容；复杂技能请逐项验证。"
    );
    panel("SelectedSkill").SetHasClass(
      "HasRisk",
      !!item && !!item.requiresRisk
    );
    updateEnabled();
  }
  function updateEnabled() {
    var selected = model.selected,
      duplicate = false,
      catalog = model.catalog;
    model.skills.forEach(function (skill) {
      if (selected && skill.name === selected.name) duplicate = true;
    });
    panel("AddSkill").enabled =
      !!selected &&
      !busy() &&
      !duplicate &&
      (!selected.requiresRisk || model.allowRisk);
    panel("PreviousPage").enabled = !!catalog && model.page > 1;
    panel("NextPage").enabled =
      !!catalog && model.page * model.pageSize < Number(catalog.total);
  }
  function confirmation(payload, sent) {
    if (!sent || ["add", "level", "remove"].indexOf(sent.action) < 0) return;
    var found = null;
    model.skills.forEach(function (item) {
      if (item.name === sent.ability && item.owned === true) found = item;
    });
    if (sent.action === "add" && found)
      status(
        "已添加：" + abilityName(found) + " · 等级 " + found.level,
        "success"
      );
    else if (
      sent.action === "level" &&
      found &&
      Number(found.level) === sent.level
    )
      status(
        "等级已确认：" + abilityName(found) + " · " + found.level,
        "success"
      );
    else if (sent.action === "remove" && !found)
      status(
        "已删除：" +
          localized("#DOTA_Tooltip_ability_" + sent.ability, sent.ability),
        "success"
      );
    else status("服务器未确认预期技能状态。请刷新后检查。", "error");
  }
  function receive(payload) {
    if (!payload || typeof payload !== "object") return;
    var sent = model.requests[payload.requestId],
      catalog = payload.catalog;
    if (
      typeof payload.revision === "number" &&
      payload.revision < model.revision
    )
      return;
    if (typeof payload.revision === "number") model.revision = payload.revision;
    model.skills = array(payload.skills).map(normalized);
    model.pending =
      payload.pending && payload.pending.ability ? payload.pending : null;
    if (payload.hero)
      text("CurrentHero", heroName(payload.hero.unitName || payload.hero.name));
    if (
      catalog &&
      Number(catalog.pageSize) === model.pageSize &&
      catalog.query === model.query &&
      catalog.category === model.category &&
      (!sent ||
        sent.action !== "catalog" ||
        model.latestCatalog === payload.requestId) &&
      (catalog.page === model.page ||
        (sent &&
          sent.action === "catalog" &&
          model.latestCatalog === payload.requestId))
    ) {
      model.catalog = catalog;
      model.catalog.items = array(catalog.items).map(normalized);
      model.page = Number(catalog.page) || 1;
    }
    if (model.mutation === payload.requestId && !model.pending)
      model.mutation = null;
    if (!boolean(payload.ok))
      status(payload.error || "服务器拒绝了操作。", "error");
    else if (model.pending)
      status(
        "正在预载来源英雄资源：" +
          localized(
            "#DOTA_Tooltip_ability_" + model.pending.ability,
            model.pending.ability
          ) +
          "。完成后由服务器确认添加。",
        "pending"
      );
    else if (model.mutation) status("等待服务器确认…", "pending");
    else if (sent && ["add", "level", "remove"].indexOf(sent.action) >= 0)
      confirmation(payload, sent);
    else if (payload.error) status(payload.error, "success");
    else status("状态已同步。技能效果仍须实际试玩。", "success");
    if (sent && !model.pending) delete model.requests[payload.requestId];
    renderSkills();
    renderCatalog();
    renderSelected();
  }
  function searchNow() {
    model.searchToken++;
    model.query = String(panel("SkillSearch").text || "").slice(0, 96);
    model.page = 1;
    model.selected = null;
    model.allowRisk = false;
    model.catalog = null;
    panel("AllowRisk").checked = false;
    renderCatalog();
    renderSelected();
    catalogRequest();
  }
  function searchChanged() {
    var token = ++model.searchToken;
    $.Schedule(0.25, function () {
      if (token === model.searchToken) searchNow();
    });
  }
  function categoryChanged() {
    var selected = panel("SkillCategory").GetSelected(),
      category = selected && selected.id;
    if (!categories[category]) return;
    model.category = category;
    searchNow();
  }
  function pageChange(delta) {
    if (!model.catalog) return;
    var pages = Math.max(1, Math.ceil(model.catalog.total / model.pageSize));
    model.page = Math.max(1, Math.min(pages, model.page + delta));
    catalogRequest();
  }
  function add() {
    var item = model.selected;
    if (!item || busy() || (item.requiresRisk && !model.allowRisk)) return;
    request("add", { ability: item.name, allowRisk: model.allowRisk });
  }
  function init() {
    GameEvents.Subscribe(RESPONSE, receive);
    panel("SkillCategory").SetSelected("default");
    updateEnabled();
    $.Schedule(0, function () {
      request("snapshot", {});
      catalogRequest();
    });
  }
  return {
    Init: init,
    Refresh: function () {
      request("snapshot", {});
      catalogRequest();
    },
    Toggle: function () {
      var node = panel("EditorDock");
      node.ToggleClass("Collapsed");
      text("ToggleGlyph", node.BHasClass("Collapsed") ? "+" : "−");
    },
    ToggleNative: function () {
      panel("EditorDock").ToggleClass("ShowNative");
    },
    Close: function () {
      request("close", {});
    },
    SearchChanged: searchChanged,
    SearchNow: searchNow,
    CategoryChanged: categoryChanged,
    Page: pageChange,
    Add: add,
    RiskChanged: function () {
      model.allowRisk = panel("AllowRisk").checked === true;
      updateEnabled();
    }
  };
})();
ChronicleLabyrinthAbilityEditor.Init();

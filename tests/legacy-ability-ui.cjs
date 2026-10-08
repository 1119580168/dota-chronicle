// Tests the original Panorama ES5 controller with a deterministic native-panel
// mock. This does not emulate the game renderer or prove 2019 runtime rendering.
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  ui = path.join(root, "tools", "legacy-ability", "ui"),
  script = fs.readFileSync(
    path.join(ui, "scripts/custom_game/chronicle_ability_editor.js"),
    "utf8"
  ),
  xml = fs.readFileSync(
    path.join(ui, "layout/custom_game/chronicle_ability_editor.xml"),
    "utf8"
  ),
  nodes = {},
  requests = [],
  timers = [],
  subscriptions = {};
let now = 0;
assert.doesNotMatch(script, /^\s*(?:let|const|class)\s|=>|\?\.|\?\?|`/m);
assert.doesNotMatch(
  script,
  /\beval\s*\(|new\s+Function|OnSpellStart|SendCustomGameEventToServer\([^R]/
);
assert.match(
  xml,
  /file:\/\/\{resources\}\/styles\/custom_game\/chronicle_ability_editor\.css/
);
assert.match(
  xml,
  /file:\/\/\{resources\}\/scripts\/custom_game\/chronicle_ability_editor\.js/
);
// Native TextEntry/DropDown subpanels need the installed 7.22 foundation styles.
assert.match(xml, /s2r:\/\/panorama\/styles\/dotastyles\.vcss_c/);
assert.ok(
  xml.indexOf("dotastyles.vcss_c") <
    xml.indexOf("chronicle_ability_editor.css"),
  "Original control overrides follow the game's installed foundation"
);
// DynamicHud_Create assigns the top panel ID; authoring XML must leave it unset.
const rootPanel = xml.match(/<Panel\b([^>]*)>/);
assert.ok(rootPanel, "DynamicHUD layout has a top-level panel");
assert.doesNotMatch(rootPanel[1], /\bid\s*=/);
assert.match(rootPanel[1], /\bclass="ChronicleAbilityRoot"/);
assert.match(script, /var root = \$\.GetContextPanel\(\);/);

class Panel {
  constructor(type, parent, id) {
    this.type = type;
    this.parent = parent;
    this.id = id;
    this.children = [];
    this.events = {};
    this.classes = new Set();
    this.text = "";
    this.enabled = true;
    this.visible = true;
    this.checked = false;
    if (id) nodes[id] = this;
    if (parent) parent.children.push(this);
  }
  FindChildTraverse(id) {
    return nodes[id] || null;
  }
  AddClass(name) {
    this.classes.add(name);
  }
  SetHasClass(name, enabled) {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }
  ToggleClass(name) {
    this.SetHasClass(name, !this.BHasClass(name));
  }
  BHasClass(name) {
    return this.classes.has(name);
  }
  RemoveAndDeleteChildren() {
    this.children = [];
  }
  SetPanelEvent(name, handler) {
    this.events[name] = handler;
  }
  SetSelected(id) {
    this.selectedId = id;
  }
  GetSelected() {
    return nodes[this.selectedId];
  }
}
const context = new Panel("Panel", null, "Context");
for (const match of xml.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g))
  new Panel(match[1], context, match[2]);
const localizations = {
  "#DOTA_Tooltip_ability_sven_storm_bolt": "风暴之拳",
  "#npc_dota_hero_sven": "斯温",
  "#npc_dota_hero_rattletrap": "发条技师"
};
const sandbox = {
  $: {
    GetContextPanel: () => context,
    CreatePanel: (type, parent, id) => new Panel(type, parent, id),
    Localize: (token) => localizations[token] || token,
    Schedule: (delay, handler) => timers.push({ at: now + delay, handler })
  },
  GameEvents: {
    Subscribe: (name, handler) => {
      subscriptions[name] = handler;
      return 1;
    },
    SendCustomGameEventToServer: (name, payload) => {
      assert.equal(name, "chronicle_ability_ui_request");
      requests.push(JSON.parse(JSON.stringify(payload)));
    }
  }
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: "chronicle_ability_editor.js" });
const api = sandbox.ChronicleAbilityEditor;
function advance(seconds) {
  const until = now + seconds;
  let steps = 0;
  while (true) {
    timers.sort((a, b) => a.at - b.at);
    if (!timers.length || timers[0].at > until) break;
    assert.ok(++steps < 200);
    const timer = timers.shift();
    now = timer.at;
    timer.handler();
  }
  now = until;
}
advance(0);
assert.deepEqual(
  requests.map((request) => request.action),
  ["snapshot", "catalog"]
);
assert.equal(requests.at(-1).pageSize, 5);
const native = {
  name: "rattletrap_battery_assault",
  index: 0,
  level: 2,
  maxLevel: 4,
  owned: false,
  readonly: true,
  hidden: false,
  active: true
};
const storm = {
  name: "sven_storm_bolt",
  sourceHero: "npc_dota_hero_sven",
  maxLevel: 4,
  requiresRisk: false,
  localizationToken: "#DOTA_Tooltip_ability_sven_storm_bolt",
  dependencyNote: "原生效果需实际试玩验证。"
};
let revision = 0;
function reply(request, overrides = {}) {
  subscriptions.chronicle_ability_ui_state({
    requestId: request.requestId,
    ok: true,
    revision,
    hero: { unitName: "npc_dota_hero_rattletrap" },
    skills: { 1: native },
    catalog: {
      query: "",
      category: "default",
      page: 1,
      pageSize: 5,
      total: 1,
      items: { 1: storm }
    },
    ...overrides
  });
}
reply(requests[1], {
  ok: 1,
  skills: { 1: { ...native, owned: 0, readonly: 1 } }
});
assert.equal(nodes.CurrentHero.text, "发条技师");
assert.equal(nodes.NativeSkills.children.length, 1);
assert.equal(
  nodes.NativeSkills.children[0].children.filter(
    (node) => node.type === "Button"
  ).length,
  0
);
assert.equal(
  nodes.CatalogSkills.children[0].children[0].abilityname,
  "sven_storm_bolt"
);
assert.equal(
  nodes.CatalogSkills.children[0].children[1].children[0].text,
  "风暴之拳"
);
nodes.CatalogSkills.children[0].events.onactivate();
assert.equal(nodes.AddSkill.enabled, true);
api.Add();
const add = requests.at(-1);
assert.equal(add.action, "add");
assert.equal(
  nodes.OwnedSkills.children.length,
  0,
  "sending an add must not fabricate a skill"
);
assert.equal(nodes.AddSkill.enabled, false);
assert.doesNotMatch(nodes.OperationStatus.text, /已添加/);
reply(add, { pending: { ability: "sven_storm_bolt", stage: "precache" } });
assert.match(nodes.OperationStatus.text, /正在预载/);
assert.doesNotMatch(nodes.OperationStatus.text, /已添加/);
const added = {
  name: "sven_storm_bolt",
  index: 14,
  level: 1,
  maxLevel: 4,
  owned: true,
  readonly: false,
  hidden: false,
  active: true
};
revision++;
reply(add, {
  ok: "1",
  skills: [native, { ...added, owned: 1, readonly: 0, hidden: 0, active: 1 }]
});
assert.equal(
  nodes.OwnedSkills.children.length,
  1,
  "real slot 14 must not be rejected as invisible"
);
assert.match(nodes.OperationStatus.text, /已添加：风暴之拳/);
let ownButtons = nodes.OwnedSkills.children[0].children.filter(
  (node) => node.type === "Button"
);
ownButtons[1].events.onactivate();
let level = requests.at(-1);
assert.deepEqual(
  { action: level.action, ability: level.ability, level: level.level },
  { action: "level", ability: "sven_storm_bolt", level: 2 }
);
reply(level, { skills: [native, added] });
assert.match(nodes.OperationStatus.text, /未确认预期技能状态/);
assert.equal(nodes.StatusBlock.BHasClass("Error"), true);
ownButtons = nodes.OwnedSkills.children[0].children.filter(
  (node) => node.type === "Button"
);
ownButtons[1].events.onactivate();
level = requests.at(-1);
revision++;
reply(level, { skills: [native, { ...added, level: 2 }] });
assert.match(nodes.OperationStatus.text, /等级已确认/);
ownButtons = nodes.OwnedSkills.children[0].children.filter(
  (node) => node.type === "Button"
);
ownButtons[2].events.onactivate();
let remove = requests.at(-1);
reply(remove, {
  ok: 0,
  error: "当前实例不能删除。",
  skills: [native, { ...added, level: 2 }]
});
assert.equal(nodes.OwnedSkills.children.length, 1);
assert.equal(nodes.OperationStatus.text, "当前实例不能删除。");
ownButtons = nodes.OwnedSkills.children[0].children.filter(
  (node) => node.type === "Button"
);
ownButtons[2].events.onactivate();
remove = requests.at(-1);
revision++;
reply(remove);
assert.equal(nodes.OwnedSkills.children.length, 0);
assert.match(nodes.OperationStatus.text, /已删除/);

// Chinese query debounce and late catalog replies may never replace the new scope.
nodes.SkillSearch.text = "风";
api.SearchChanged();
nodes.SkillSearch.text = "风暴";
api.SearchChanged();
advance(0.3);
let search = requests.at(-1);
assert.equal(search.query, "风暴");
assert.equal(nodes.CatalogSkills.children.length, 0);
reply(requests[1]);
assert.equal(
  nodes.CatalogSkills.children.length,
  0,
  "old query cannot replace the active query"
);
reply(search, {
  catalog: {
    query: "风暴",
    category: "default",
    page: 1,
    pageSize: 5,
    total: 11,
    items: [storm]
  }
});
api.Page(1);
const secondPage = requests.at(-1);
api.Page(-1);
const firstPage = requests.at(-1);
reply(firstPage, {
  catalog: {
    query: "风暴",
    category: "default",
    page: 1,
    pageSize: 5,
    total: 11,
    items: [storm]
  }
});
reply(secondPage, {
  catalog: {
    query: "风暴",
    category: "default",
    page: 2,
    pageSize: 5,
    total: 11,
    items: []
  }
});
assert.equal(nodes.PageLabel.text, "1 / 3");
assert.equal(nodes.CatalogSkills.children.length, 1);

// Console state is authoritative too; old revision cannot erase newer skills.
reply(
  { requestId: "console" },
  { revision: revision + 2, skills: [native, added] }
);
reply({ requestId: "console" }, { revision, skills: [native] });
assert.equal(nodes.OwnedSkills.children.length, 1);
revision += 2;
nodes.SkillCategory.SetSelected("complex");
nodes.SkillSearch.text = "";
api.CategoryChanged();
search = requests.at(-1);
const risk = {
  name: "invoker_test_dependency",
  localizedName: "复杂依赖示例",
  sourceHero: "npc_dota_hero_invoker",
  requiresRisk: 1,
  maxLevel: 0,
  dependencyNote: "依赖未确认，不保证完整效果。"
};
reply(search, {
  skills: [native, added],
  catalog: {
    query: "",
    category: "complex",
    page: 1,
    pageSize: 5,
    total: 1,
    items: [risk]
  }
});
nodes.CatalogSkills.children[0].events.onactivate();
assert.equal(
  nodes.SelectedName.text,
  "复杂依赖示例",
  "missing localization uses server fallback"
);
assert.equal(nodes.AddSkill.enabled, false);
let count = requests.length;
api.Add();
assert.equal(requests.length, count);
nodes.AllowRisk.checked = true;
api.RiskChanged();
assert.equal(nodes.AddSkill.enabled, true);
api.Add();
const riskAdd = requests.at(-1);
assert.equal(riskAdd.allowRisk, true);
assert.equal(riskAdd.ability, risk.name);
assert.equal(
  nodes.OwnedSkills.children.length,
  1,
  "risk request still cannot fabricate success"
);
advance(13);
assert.match(nodes.OperationStatus.text, /操作结果未确认/);
api.Toggle();
assert.equal(nodes.EditorDock.BHasClass("Collapsed"), true);
api.Toggle();
assert.equal(nodes.EditorDock.BHasClass("Collapsed"), false);
api.ToggleNative();
assert.equal(nodes.EditorDock.BHasClass("ShowNative"), true);
api.Close();
assert.equal(requests.at(-1).action, "close");
assert.ok(
  requests.every((request) =>
    ["snapshot", "catalog", "add", "level", "remove", "close"].includes(
      request.action
    )
  )
);
console.log(
  "Panorama controller mock passed: server-only skill state, pending/timeout/error, owned-only controls, slot14, native readonly, Lua arrays, localization fallback, paging/search race, risk confirmation; no game or renderer launch."
);

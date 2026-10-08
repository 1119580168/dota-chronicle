-- Original synthetic engine model. No Valve KV or native game assets are embedded.
-- Run from repository root using Lua 5.1+ or Fengari; syntax is checked separately as Lua 5.1.
local source = "tools/legacy-ability/chronicle_skill_editor_v1.lua"
local output, assertions = print, 0
local function expect(condition, message)
    assertions = assertions + 1
    if not condition then error("ASSERTION " .. assertions .. ": " .. message, 2) end
end
local function equal(actual, expected, message) expect(actual == expected, message) end
local function fixture()
    local env = { server = true, dedicated = false, cheats = true, map = "hero_demo_main",
        playerCount = 1, clone = false, commands = {}, sent = {}, precache = {}, timers = {},
        createdHud = {}, destroyedHud = {}, logs = {}, addCalls = 0, removeCalls = 0 }
    local function ability(name, index, maximum)
        local object = { name = name, index = index, maximum = maximum or 4,
            level = 0, hidden = false, active = true, null = false }
        function object:IsNull() return self.null end
        function object:GetAbilityName() return self.name end
        function object:GetAbilityIndex() return self.index end
        function object:GetLevel() return self.level end
        function object:GetMaxLevel() return self.maximum end
        function object:IsHidden() return self.hidden end
        function object:IsActivated() return self.active end
        function object:SetLevel(value)
            if env.levelThrow then error("synthetic level failure") end
            if not env.levelNoop then self.level = value end
            if env.changeOriginalOnLevel then env.original.level = env.original.level + 1 end
        end
        return object
    end
    local function hero(name)
        local object = { name = name, slots = {}, owner = 3, null = false }
        function object:IsNull() return self.null end
        function object:IsRealHero() return true end
        function object:IsClone() return env.clone end
        function object:GetPlayerOwnerID() return self.owner end
        function object:GetUnitName() return self.name end
        function object:GetAbilityCount() return 30 end
        function object:GetAbilityByIndex(index) return self.slots[index] end
        function object:FindAbilityByName(name)
            for _, handle in pairs(self.slots) do if handle.name == name then return handle end end
            return nil
        end
        function object:AddAbility(name)
            env.addCalls = env.addCalls + 1
            if env.addMode == "reject" then return nil end
            if env.addMode == "foreign" then return env.original end
            local index
            for candidate = 0, 29 do if self.slots[candidate] == nil then index = candidate break end end
            if not index then return nil end
            local handle = ability(name, index, name == "special_bonus_test" and 1 or 4)
            self.slots[index] = handle
            if env.changeOriginalOnAdd then env.original.level = env.original.level + 1 end
            if env.addMode == "partial" then return nil end
            if env.addMode == "throwPartial" then error("synthetic add failure after creation") end
            return handle
        end
        function object:RemoveAbility(name)
            env.removeCalls = env.removeCalls + 1
            if env.removeFail then return end
            for index, handle in pairs(self.slots) do
                if handle.name == name then self.slots[index] = nil handle.null = true return end
            end
        end
        return object
    end
    env.makeAbility, env.makeHero = ability, hero
    env.hero = hero("npc_dota_hero_test_local")
    env.original = ability("test_original", 0, 4)
    env.original.level = 2
    env.talent = ability("special_bonus_original", 13, 1)
    env.talent.hidden, env.talent.active = true, false
    env.hero.slots[0], env.hero.slots[13] = env.original, env.talent
    env.host = { IsNull = function() return false end, GetPlayerID = function() return 3 end,
        GetAssignedHero = function() return env.hero end }
    env.remote = { IsNull = function() return false end, GetPlayerID = function() return 9 end }
    env.issuer = env.host
    local kv = {
        ["scripts/npc/npc_abilities.txt"] = { DOTAAbilities = {
            test_original = { MaxLevel = "4" }, test_bolt = { MaxLevel = "4" },
            test_slow = { MaxLevel = "4", AssociatedSecondaryAbilities = "test_hidden" },
            test_no_source = { MaxLevel = "4" },
            test_hidden = { AbilityBehavior = "DOTA_ABILITY_BEHAVIOR_HIDDEN" },
            special_bonus_test = { MaxLevel = "1" }, attribute_bonus = {}, generic_hidden = {},
            invoker_test_complex = { MaxLevel = "4" },
            test_custom_lua = { BaseClass = "ability_lua" }, ability_base = {},
        } },
        ["scripts/npc/npc_heroes.txt"] = { DOTAHeroes = {
            npc_dota_hero_base = {}, npc_dota_hero_test_local = { Ability1 = "test_original" },
            npc_dota_hero_test_bolt = { Ability1 = "test_bolt", Ability2 = "test_slow",
                Ability3 = "test_hidden", Ability4 = "special_bonus_test", Ability5 = "invoker_test_complex" },
        } },
        ["scripts/npc/items.txt"] = { DOTAAbilities = { item_test = { MaxLevel = "1" } } },
        ["scripts/npc/chronicle_skill_localization_v1.txt"] = { ChronicleSkillLocalization = {
            Tokens = { test_bolt = "测试闪电", test_slow = "Test Slow" },
            SearchTokens = { test_bolt = "Test Bolt 测试闪电", test_slow = "Test Slow 测试减速" },
        } },
    }
    _G.__chronicle_skill_editor_v1 = nil
    _G.print = function(value) table.insert(env.logs, tostring(value)) end
    _G.FCVAR_CHEAT = 16384
    _G.IsServer = function() return env.server end
    _G.IsDedicatedServer = function() return env.dedicated end
    _G.GetListenServerHost = function() return env.host end
    _G.GetMapName = function() return env.map end
    _G.EntIndexToHScript = function(index) if index == 42 then return env.host elseif index == 84 then return env.remote end end
    _G.PlayerResource = { GetPlayerCount = function() return env.playerCount end }
    _G.Convars = {
        GetBool = function(_, name) equal(name, "sv_cheats", "only expected cvar read") return env.cheats end,
        GetCommandClient = function() return env.issuer end,
        RegisterCommand = function(_, name, callback, _, flags)
            equal(flags, FCVAR_CHEAT, "commands require FCVAR_CHEAT")
            expect(env.commands[name] == nil, "commands are registered once")
            env.commands[name] = callback
        end,
    }
    local mode = { SetContextThink = function(_, name, callback, delay)
        if env.timerFail then error("synthetic timer failure") end
        env.timers[name] = { callback = callback, delay = delay }
    end }
    _G.GameRules = { herodemo = {}, GetGameModeEntity = function() return mode end }
    _G.LoadKeyValues = function(path)
        expect(not path:match("^resource/localization/"), "never read native UTF16 localization with Lua LoadKeyValues")
        return kv[path]
    end
    _G.PrecacheUnitByNameAsync = function(name, callback)
        if env.precacheThrow then error("synthetic precache failure") end
        if env.precacheSync then callback() else table.insert(env.precache, { name = name, callback = callback }) end
    end
    _G.CustomGameEventManager = {
        RegisterListener = function(_, name, callback)
            equal(name, "chronicle_ability_ui_request", "fixed request event")
            expect(env.listener == nil, "listener is registered once")
            env.listener = callback
            return 1
        end,
        Send_ServerToPlayer = function(_, player, name, data)
            equal(player, env.host, "responses only go to host entity")
            equal(name, "chronicle_ability_ui_state", "fixed response event")
            table.insert(env.sent, data)
        end,
    }
    _G.CustomUI = {
        DynamicHud_Create = function(_, playerID, id, layout)
            table.insert(env.createdHud, { playerID = playerID, id = id, layout = layout })
        end,
        DynamicHud_Destroy = function(_, playerID, id)
            table.insert(env.destroyedHud, { playerID = playerID, id = id })
        end,
    }
    env.module = assert(dofile(source))
    function env:finishPrecache() local operation = table.remove(self.precache, 1) expect(operation ~= nil, "precache is pending") operation.callback() end
    function env:originalIntact()
        equal(self.hero.slots[0], self.original, "original slot remains same handle")
        equal(self.original.level, 2, "original level preserved")
        equal(self.talent.hidden, true, "talent hidden preserved")
        equal(self.talent.active, false, "talent activation preserved")
    end
    return env
end

local e = fixture()
local count = 0 for _ in pairs(e.commands) do count = count + 1 end
equal(count, 8, "eight public commands")
expect(e.module.Register(), "repeat registration succeeds")
equal(dofile(source), e.module, "reloading reuses instance with owned-state retention")
local entries = assert(e.module.Search({}))
equal(entries.total, 5, "default directory hides advanced categories")
equal(assert(e.module.Search({ query = "测试闪电" })).total, 1, "native localized search")
local chineseName = assert(e.module.Search({ query = "Test Bolt" })).items[1]
equal(chineseName.name, "test_bolt", "English alternate matches Chinese selected display")
equal(chineseName.localizedName, "测试闪电", "selected Chinese name preserved")
equal(assert(e.module.Search({ query = "TEST BOLT" })).total, 1, "English alternate search is case insensitive")
local englishName = assert(e.module.Search({ query = "测试减速" })).items[1]
equal(englishName.name, "test_slow", "Chinese alternate matches English selected display")
equal(englishName.localizedName, "Test Slow", "selected English fallback preserved")
expect(e.commands.chronicle_skill_catalog("chronicle_skill_catalog", "测试闪电", "", ""), "empty native optional args fall back to default")
equal(e.sent[#e.sent].catalog.total, 1, "Chinese console query uses synthetic local tokens")
expect(e.commands.chronicle_skill_catalog("chronicle_skill_catalog", "default", "测试闪电", ""), "category-first console convenience")
equal(e.sent[#e.sent].catalog.total, 1, "category-first query preserves localized search")
equal(assert(e.module.Search({ category = "hidden" })).total, 1, "hidden category")
equal(assert(e.module.Search({ category = "talent" })).total, 2, "talent category")
equal(assert(e.module.Search({ category = "item" })).total, 1, "item category")
equal(assert(e.module.Search({ category = "generic" })).total, 1, "generic category")
equal(assert(e.module.Search({ category = "complex" })).total, 2, "complex family and KV dependency warnings")
local related = assert(e.module.Search({ query = "test_slow" })).items[1]
equal(related.associatedAbilities[1], "test_hidden", "native KV associations are only reported")
expect(related.requiresRisk, "associated skill requires explicit risk")
equal(assert(e.module.Search({ page = 100, pageSize = 2 })).page, 3, "page clamped")
expect(e.module.Search({ category = "invalid" }) == nil, "unknown category refused")
expect(e.module.Search({ pageSize = 25 }) == nil, "directory payload bounded")
expect(not e.module.Add("test_custom_lua"), "custom Lua definitions excluded")
expect(not e.module.Add("test_hidden"), "advanced entry requires explicit risk")
expect(not e.module.Add("test_no_source"), "missing source requires explicit risk")
expect(not e.module.Add("test_bolt", { sourceHero = "npc_dota_hero_foreign" }), "arbitrary precache source denied")
expect(not e.module.Add("test_bolt", { level = -1 }), "negative level denied")
expect(not e.module.Add("test_bolt", { level = 1.5 }), "fractional level denied")
expect(not e.module.Add("test_bolt", { level = 5 }), "KV explicit upper bound enforced")
local requestOptions = { level = 1 }
expect(e.module.Add("test_bolt", requestOptions, "async-1"), "valid addition starts async precache")
requestOptions.level = 4
equal(e.addCalls, 0, "no mutation before resources")
expect(not e.module.Add("test_slow"), "parallel additions denied")
expect(not e.module.Remove("test_original"), "pending deletion denied")
e:finishPrecache()
local added = e.hero:FindAbilityByName("test_bolt")
expect(added ~= nil, "async addition creates native handle")
equal(added.level, 1, "level copied before async boundary")
equal(e.sent[#e.sent].requestId, "async-1", "async response preserves request id")
expect(e.sent[#e.sent].ok, "completed add response succeeds")
e:originalIntact()
expect(e.module.Level("test_bolt", 0), "owned skill can unlearn to zero")
expect(e.module.Level("test_bolt", 4), "owned skill can use native maximum")
expect(not e.module.Level("test_bolt", 5), "over-maximum denied")
expect(not e.module.Level("test_original", 3), "original skill level denied")
expect(not e.module.Remove("test_original"), "original removal denied")
expect(not e.module.Add("test_bolt"), "existing skill cannot be overwritten")
expect(e.module.Remove("test_bolt"), "owned native instance removed")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "remove readback")
e:originalIntact()
expect(e.module.OpenPanel(), "owned dynamic HUD request")
equal(e.createdHud[1].playerID, 3, "HUD current player id")
equal(e.createdHud[1].id, "chronicle_ability_editor", "unique element only")
equal(e.createdHud[1].layout, "file://{resources}/layout/custom_game/chronicle_ability_editor.xml", "unique native resource URL")
local sentBefore = #e.sent
expect(not e.module.HandleRequest(84, { requestId = "spoof", action = "add", ability = "test_slow", PlayerID = 3 }), "foreign entity cannot spoof payload id")
equal(#e.sent, sentBefore, "foreign request gets no host response")
expect(not e.module.HandleRequest(3, { requestId = "pid", action = "snapshot", PlayerID = 3 }), "player id is not accepted as entity source")
expect(e.module.HandleRequest(42, { requestId = "view", action = "snapshot", PlayerID = 9 }), "authoritative host source ignores supplied PlayerID")
equal(e.sent[#e.sent].skills[1].readonly, true, "original is read only in UI")
local function readyMarks()
    local count = 0
    for _, line in ipairs(e.logs) do if line:match("^CHRONICLE_SKILL_EDITOR_UI_READY ") then count = count + 1 end end
    return count
end
equal(readyMarks(), 1, "first authenticated snapshot acknowledges the shown panel")
expect(e.module.HandleRequest(42, { requestId = "view-again", action = "snapshot" }), "repeated authenticated snapshot")
equal(readyMarks(), 1, "ready marker occurs only once per panel show")
expect(e.module.ClosePanel(), "close after acknowledged UI")
expect(e.module.HandleRequest(42, { requestId = "closed-view", action = "snapshot" }), "closed panel can still read state")
equal(readyMarks(), 1, "snapshot without an open owned panel is not UI readiness")
expect(e.module.OpenPanel(), "reopen owned panel")
expect(e.module.HandleRequest(42, { requestId = "reopen-view", action = "snapshot" }), "new panel's authenticated snapshot")
equal(readyMarks(), 2, "reopen resets one-time UI acknowledgement")
local existingService = e.module
equal(dofile(source), existingService, "reload retains original owned service instance")
equal(e.destroyedHud[#e.destroyedHud].id, "chronicle_ability_editor", "reload only clears its own HUD handshake")
expect(e.module.OpenPanel(), "reload permits a fresh independent panel request")
expect(e.module.HandleRequest(42, { requestId = "after-reuse", action = "snapshot" }), "reuse requires another real authenticated snapshot")
equal(readyMarks(), 3, "reuse does not replace the new snapshot with a cached UI-ready claim")
e.cheats = false
expect(e.module.HandleRequest(42, { requestId = "close", action = "close" }), "owned HUD can close after cheats are disabled")
equal(e.destroyedHud[1].id, "chronicle_ability_editor", "does not destroy native HUD")
expect(not e.module.Add("test_slow"), "mutation denied after cheats disabled")

for _, field in ipairs({ "server", "dedicated", "playerCount", "map", "clone", "issuer", "owner" }) do
    e = fixture()
    if field == "server" then e.server = false
    elseif field == "dedicated" then e.dedicated = true
    elseif field == "playerCount" then e.playerCount = 2
    elseif field == "map" then e.map = "dota"
    elseif field == "clone" then e.clone = true
    elseif field == "issuer" then e.issuer = e.remote
    elseif field == "owner" then e.hero.owner = 9 end
    expect(not e.module.Add("test_bolt"), field .. " authorization refused")
    equal(e.addCalls, 0, field .. " refusal has no native mutation")
end
e = fixture()
GameRules.herodemo = false
expect(not e.module.OpenPanel(), "false demo marker is not authorization")
e = fixture()
expect(not e.module.Add("test_bolt", {}, nil, { host = e.host, hero = e.hero, playerID = 3, map = "dota" }), "caller-supplied context cannot bypass native checks")

e = fixture()
expect(e.module.Add("test_bolt"), "hero-change test queues precache")
local oldHero = e.hero
e.hero = e.makeHero("npc_dota_hero_test_other")
e:finishPrecache()
equal(e.addCalls, 0, "hero switch cancels delayed mutation")
equal(oldHero:FindAbilityByName("test_bolt"), nil, "old hero not mutated")
expect(not e.sent[#e.sent].ok, "hero-change result is failure")
e = fixture()
expect(e.module.Add("test_bolt"), "close test queues precache")
expect(e.module.ClosePanel(), "close cancels pending even if panel not opened")
e:finishPrecache()
equal(e.addCalls, 0, "late callback after close is inert")
e = fixture()
expect(e.module.Add("test_bolt"), "timeout test queues precache")
e.timers["ChronicleSkillEditor:PrecacheTimeout"].callback()
e:finishPrecache()
equal(e.addCalls, 0, "late callback after timeout is inert")
e = fixture()
e.timerFail = true
expect(not e.module.Add("test_bolt"), "missing timeout protection rejects pending action")
e:finishPrecache()
equal(e.addCalls, 0, "failed timer cancels late callback")

for _, mode in ipairs({ "partial", "throwPartial" }) do
    e = fixture()
    e.precacheSync, e.addMode = true, mode
    expect(not e.module.Add("test_bolt"), "sync partial add is reported failed")
    expect(e.hero:FindAbilityByName("test_bolt") ~= nil, "partial is tracked")
    expect(not e.module.Level("test_bolt", 2), "partial is cleanup only")
    expect(e.module.Remove("test_bolt"), "exact partial instance can be removed")
    e:originalIntact()
end
e = fixture()
e.precacheSync, e.addMode = true, "foreign"
expect(not e.module.Add("test_bolt"), "foreign native return is rejected")
equal(e.original.level, 2, "foreign handle is never levelled")
expect(not e.module.Remove("test_original"), "foreign return creates no ownership")
e = fixture()
e.precacheSync, e.levelNoop, e.removeFail = true, true, true
expect(not e.module.Add("test_bolt"), "failed level readback and cleanup reported")
expect(not e.module.Level("test_bolt", 2), "failed cleanup residue stays removal only")
e.levelNoop, e.removeFail = false, false
expect(e.module.Remove("test_bolt"), "residue can be explicitly cleaned")
e = fixture()
e.precacheSync, e.changeOriginalOnAdd = true, true
expect(not e.module.Add("test_bolt"), "native changes to original state fail verification")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "only new skill is cleaned after preservation failure")
equal(e.original.level, 3, "does not rewrite original state or falsely claim restoration")
e = fixture()
e.precacheSync = true
expect(e.module.Add("test_bolt"), "ownership swap test adds")
local oldAdded = e.hero:FindAbilityByName("test_bolt")
e.hero.slots[oldAdded.index] = e.makeAbility("test_bolt", oldAdded.index, 4)
expect(not e.module.Remove("test_bolt"), "same-name foreign replacement not owned")
expect(not e.module.Level("test_bolt", 2), "replacement cannot be upgraded")
e = fixture()
for index = 0, 29 do if not e.hero.slots[index] then e.hero.slots[index] = e.makeAbility("test_filler_" .. index, index, 1) end end
expect(not e.module.Add("test_bolt"), "full slots refused before native mutation")
equal(e.addCalls, 0, "full slot mutation count remains zero")
e = fixture()
expect(e.module.Add("test_no_source", { allowRisk = "1", level = 1 }), "advanced confirmation permits source-unknown attempt")
equal(#e.precache, 0, "source-unknown entry does not claim precaching")
expect(e.module.Remove("test_no_source"), "source-unknown exact instance still removable")
e = fixture()
expect(e.commands.chronicle_skill_add("chronicle_skill_add", "test_bolt", "1"), "registered console add uses the same service")
e:finishPrecache()
expect(e.commands.chronicle_skill_level("chronicle_skill_level", "test_bolt", "2"), "registered console level uses the same service")
equal(e.hero:FindAbilityByName("test_bolt").level, 2, "command level readback")
expect(e.commands.chronicle_skill_remove("chronicle_skill_remove", "test_bolt"), "registered console remove uses the same service")
e = fixture()
expect(e.module.HandleRequest(42, { requestId = "rpc-add", action = "add", ability = "test_bolt", level = 1 }), "authenticated RPC queues service add")
expect(e.sent[#e.sent].pending ~= nil, "RPC acknowledgement reports pending")
e:finishPrecache()
equal(e.sent[#e.sent].requestId, "rpc-add", "RPC completion preserves id")
expect(e.sent[#e.sent].pending == nil and e.sent[#e.sent].ok, "RPC completion no longer pending")
expect(e.module.HandleRequest(42, { requestId = "rpc-level", action = "level", ability = "test_bolt", level = 2 }), "authenticated RPC changes owned level")
expect(e.module.HandleRequest(42, { requestId = "rpc-remove", action = "remove", ability = "test_bolt" }), "authenticated RPC removes owned skill")
expect(not e.module.HandleRequest(42, { requestId = "rpc-code", action = "execute", code = "arbitrary" }), "RPC has no arbitrary-code action")

_G.print = output
output("CHRONICLE_SKILL_EDITOR_MOCK_PASS assertions=" .. assertions)

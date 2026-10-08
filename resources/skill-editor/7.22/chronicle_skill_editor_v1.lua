-- Original Dota Chronicle server-side editor, Lua 5.1-compatible.
-- Intended runtime: locally owned, single-player 7.22 native hero_demo.
-- Reads the user's runtime KV; does not embed or rewrite Valve game data.

local KEY = "__chronicle_skill_editor_v1"
if _G[KEY] then
    local existing = _G[KEY]
    -- Preserve added-instance ownership. A deliberate reload only re-arms our
    -- own HUD handshake; it must not silently assert that old UI is still alive.
    if type(existing.ClosePanel) == "function" then
        local ok, reason = existing.ClosePanel()
        if not ok then print("CHRONICLE_SKILL_REFUSED " .. tostring(reason)) return existing end
    end
    print("CHRONICLE_SKILL_REUSE existing instance; new source needs a fresh Lua VM")
    print("CHRONICLE_SKILL_EDITOR_LOADED v1 reused; ownership retained; UI requires a new snapshot")
    return existing
end

local M = { version = 1 }
local REQUEST = "chronicle_ability_ui_request"
local RESPONSE = "chronicle_ability_ui_state"
local HUD = "chronicle_ability_editor"
local LAYOUT = "file://{resources}/layout/custom_game/chronicle_ability_editor.xml"
local directory, ordered, heroDefinitions = nil, nil, nil
local localizedSearch = {}
local ownedByHero, cachedHeroes, registered = {}, {}, {}
local pending, listener, panelHost = nil, nil, nil
local panelReady = false
local generation, revision = 0, 0
local view = { query = "", category = "default", page = 1, pageSize = 18 }
local categories = { default = true, all = true, hidden = true, talent = true,
    item = true, generic = true, complex = true }

local function log(marker, text)
    print("CHRONICLE_SKILL_" .. marker .. (text and (" " .. tostring(text)) or ""))
end

local function call(object, name, ...)
    if object == nil then return false, "missing object: " .. name end
    local ok, method = pcall(function() return object[name] end)
    if not ok or type(method) ~= "function" then return false, "missing method: " .. name end
    return pcall(method, object, ...)
end

local function valid(handle)
    if handle == nil then return false end
    local ok, null = call(handle, "IsNull")
    return ok and null == false
end

local function integer(value, minimum, maximum)
    local n = tonumber(value)
    if not n or n ~= math.floor(n) or n < minimum or n > maximum then return nil end
    return n
end

local function checked(value)
    return value == true or value == 1 or value == "1" or value == "true"
end

local function abilityName(name)
    return type(name) == "string" and #name <= 128 and name:match("^[a-z][a-z0-9_]*$") ~= nil
end

local function hostGuard(cheatsRequired, checkCommandIssuer)
    if type(IsServer) ~= "function" or not IsServer() then return nil, "需要服务端 Lua。" end
    if type(IsDedicatedServer) ~= "function" or IsDedicatedServer() then return nil, "仅允许本机监听服务器。" end
    if cheatsRequired then
        local ok, enabled = call(Convars, "GetBool", "sv_cheats")
        if not ok or enabled ~= true then return nil, "需要启用本地试玩作弊。" end
    end
    if type(GetListenServerHost) ~= "function" then return nil, "缺少本机玩家接口。" end
    local ok, host = pcall(GetListenServerHost)
    if not ok or not valid(host) then return nil, "本机玩家尚未就绪。" end
    if checkCommandIssuer then
        local issuerOK, issuer = call(Convars, "GetCommandClient")
        if not issuerOK or (issuer ~= nil and issuer ~= host) then return nil, "仅本机玩家可操作。" end
    end
    return host
end

local function context(checkCommandIssuer)
    local host, reason = hostGuard(true, checkCommandIssuer)
    if not host then return nil, reason end
    if GameRules == nil or type(GameRules.herodemo) ~= "table" then return nil, "仅支持原生英雄试玩。" end
    local mapOK, mapName = false, nil
    if type(GetMapName) == "function" then mapOK, mapName = pcall(GetMapName) end
    if not mapOK or type(mapName) ~= "string" or not mapName:match("^hero_demo_") then
        return nil, "需要原生英雄试玩地图。"
    end
    local countOK, count = call(PlayerResource, "GetPlayerCount")
    if not countOK or tonumber(count) ~= 1 then return nil, "当前工具仅支持单人试玩。" end
    local heroOK, hero = call(host, "GetAssignedHero")
    local realOK, real = call(hero, "IsRealHero")
    local idOK, playerID = call(host, "GetPlayerID")
    local ownerOK, ownerID = call(hero, "GetPlayerOwnerID")
    if not heroOK or not valid(hero) or not realOK or not real
        or not idOK or not ownerOK or playerID ~= ownerID then return nil, "本机英雄尚未就绪。" end
    local cloneOK, clone = call(hero, "IsClone")
    if cloneOK and clone then return nil, "不能编辑克隆英雄。" end
    return { host = host, hero = hero, playerID = playerID, map = mapName }
end

local function resolveContext(candidate)
    if candidate == nil then return context(true) end
    local current, reason = context(false)
    if not current then return nil, reason end
    if type(candidate) ~= "table" or candidate.host ~= current.host
        or candidate.hero ~= current.hero or candidate.map ~= current.map
        or candidate.playerID ~= current.playerID then return nil, "本机上下文已改变。" end
    return current
end

local function runtimeKV(path, root)
    if type(LoadKeyValues) ~= "function" then return nil end
    local ok, data = pcall(LoadKeyValues, path)
    if not ok or type(data) ~= "table" then return nil end
    if type(data[root]) == "table" then return data[root] end
    return data
end

local function hasFlag(flags, flag)
    return type(flags) == "string" and flags:find(flag, 1, true) ~= nil
end

local function complexFamily(name)
    for _, prefix in ipairs({ "invoker_", "morphling_", "rubick_", "meepo_", "lone_druid_", "arc_warden_" }) do
        if name:sub(1, #prefix) == prefix then return true end
    end
    return false
end

local function loadDirectory()
    if directory then return true end
    local abilities = runtimeKV("scripts/npc/npc_abilities.txt", "DOTAAbilities")
    local heroes = runtimeKV("scripts/npc/npc_heroes.txt", "DOTAHeroes")
    if not abilities or not heroes then return false, "无法读取本机技能或英雄 KV。" end
    local items = runtimeKV("scripts/npc/items.txt", "DOTAAbilities") or {}
    -- Native LoadKeyValues cannot reliably parse this client's UTF-16
    -- localization originals. The launcher generates this UTF-8 name-only KV
    -- from the user's own VPK and owns its temporary file lease.
    local localization = runtimeKV("scripts/npc/chronicle_skill_localization_v1.txt", "ChronicleSkillLocalization")
    local tokens = {}
    if localization and type(localization.Tokens) == "table" then
        for name, value in pairs(localization.Tokens) do
            if type(name) == "string" and abilityName(name:lower()) and type(value) == "string" then
                tokens[name:lower()] = value
            end
        end
    end
    if localization and type(localization.SearchTokens) == "table" then
        for name, value in pairs(localization.SearchTokens) do
            if type(name) == "string" and abilityName(name:lower()) and type(value) == "string" then
                localizedSearch[name:lower()] = value:lower()
            end
        end
    end
    local localizedCount = 0
    for _ in pairs(tokens) do localizedCount = localizedCount + 1 end
    log("LOCALIZATION", "runtime_tokens=" .. localizedCount .. "; source=temporary UTF8 name index")
    local sourceHeroes = {}
    heroDefinitions = {}
    for name, definition in pairs(heroes) do
        if type(name) == "string" and name:match("^npc_dota_hero_") and name ~= "npc_dota_hero_base"
            and type(definition) == "table" then
            heroDefinitions[name] = true
            for key, skill in pairs(definition) do
                if type(key) == "string" and key:match("^Ability%d+$") and abilityName(skill) then
                    sourceHeroes[skill] = sourceHeroes[skill] or {}
                    table.insert(sourceHeroes[skill], name)
                end
            end
        end
    end
    directory, ordered = {}, {}
    local function addDefinition(name, definition, isItem)
        if not abilityName(name) or type(definition) ~= "table" or directory[name]
            or name == "ability_base" or name == "dota_base_ability" or name == "item_base" then return end
        local base = tostring(definition.BaseClass or ""):lower()
        if base:find("lua", 1, true) or base:find("datadriven", 1, true) then return end
        local behavior = tostring(definition.AbilityBehavior or "")
        local hidden = hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_HIDDEN")
        local talent = name:match("^special_bonus_") ~= nil or name == "attribute_bonus"
            or definition.AbilityType == "DOTA_ABILITY_TYPE_ATTRIBUTES"
        local item = isItem or name:match("^item_") ~= nil or hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_ITEM")
        local generic = name == "generic_hidden" or name == "default_attack"
            or name:match("^generic_") ~= nil or name:match("^ability_") ~= nil
        local category = talent and "talent" or item and "item" or generic and "generic" or hidden and "hidden" or "ability"
        local sources = sourceHeroes[name] or {}
        table.sort(sources)
        local associated = {}
        for _, key in ipairs({ "AssociatedPrimaryAbilities", "AssociatedSecondaryAbilities" }) do
            if type(definition[key]) == "string" then
                for dependency in definition[key]:gmatch("[a-z][a-z0-9_]*") do
                    if dependency ~= name then table.insert(associated, dependency) end
                end
            end
        end
        local complex = complexFamily(name) or #associated > 0
            or hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_NOT_LEARNABLE")
        local note = complex and "需附属技能或原英雄状态；尚未验证。" or "跨英雄效果尚未验证。"
        if #associated > 0 then note = note .. " KV 关联：" .. table.concat(associated, ", ") .. "。" end
        if #sources == 0 then note = note .. " 未找到来源英雄，资源预载无法确认。" end
        if talent then note = "天赋或属性项：可能绑定原英雄；不保证跨英雄效果。" end
        if item then note = "物品技能：AddAbility 不等于获得物品，原生绑定可能拒绝添加。" end
        if generic or hidden then note = "隐藏或引擎辅助项：可能需要附属技能，不保证图标与效果。" end
        local maximum = integer(definition.MaxLevel, 0, 128)
        local estimated = maximum == nil
        if maximum == nil then maximum = definition.AbilityType == "DOTA_ABILITY_TYPE_ULTIMATE" and 3 or talent and 1 or 4 end
        local localizationToken = "#DOTA_Tooltip_ability_" .. name
        local display = tokens[name] or name
        local entry = { name = name, sourceHero = sources[1] or "", sourceHeroes = sources,
            category = category, complexity = complex and "complex" or "unverified",
            associatedAbilities = associated,
            dependencyNote = note, maxLevel = maximum, maxLevelEstimated = estimated, hidden = hidden,
            requiresRisk = category ~= "ability" or complex or #sources == 0,
            localizationToken = localizationToken, localizedName = display }
        directory[name] = entry
        table.insert(ordered, name)
    end
    for name, definition in pairs(abilities) do addDefinition(name, definition, false) end
    for name, definition in pairs(items) do addDefinition(name, definition, true) end
    table.sort(ordered)
    log("DIRECTORY", "entries=" .. #ordered .. "; source=runtime KV; complex effects unverified")
    return true
end

local function catalog(options)
    local ok, reason = loadDirectory()
    if not ok then return nil, reason end
    options = type(options) == "table" and options or {}
    local query = type(options.query) == "string" and options.query or ""
    if #query > 192 then return nil, "搜索内容过长。" end
    local category = options.category or "default"
    if not categories[category] then return nil, "未知技能分类。" end
    local size = integer(options.pageSize or 18, 1, 24)
    local page = integer(options.page or 1, 1, 10000)
    if not size or not page then return nil, "页码或每页数量无效。" end
    local needle, matches = query:lower(), {}
    for _, name in ipairs(ordered) do
        local entry = directory[name]
        local included = category == "all" or (category == "default" and entry.category == "ability")
            or category == entry.category or (category == "complex" and entry.complexity == "complex")
        if included and (needle == "" or name:find(needle, 1, true)
            or entry.localizedName:lower():find(needle, 1, true)
            or (localizedSearch[name] and localizedSearch[name]:find(needle, 1, true))
            or entry.sourceHero:find(needle, 1, true)) then
            table.insert(matches, entry)
        end
    end
    local pages = math.max(1, math.ceil(#matches / size))
    page = math.min(page, pages)
    local rows = {}
    for index = (page - 1) * size + 1, math.min(page * size, #matches) do table.insert(rows, matches[index]) end
    return { query = query, category = category, page = page, pageSize = size,
        total = #matches, totalPages = pages, items = rows }
end

local function ownedEntry(hero, name)
    local record = ownedByHero[hero] and ownedByHero[hero][name]
    if not record or not valid(record.handle) then return nil end
    local ok, current = call(hero, "FindAbilityByName", name)
    if ok and current == record.handle then return record end
    return nil
end

local function inspect(hero)
    local ok, count = call(hero, "GetAbilityCount")
    count = ok and integer(count, 1, 64) or nil
    if not count then return nil, "无法核实技能槽数量。" end
    local snapshot = { count = count, slots = {}, empty = {} }
    for index = 0, count - 1 do
        local slotOK, handle = call(hero, "GetAbilityByIndex", index)
        if not slotOK then return nil, "无法读取技能槽。" end
        if handle == nil then table.insert(snapshot.empty, index)
        elseif not valid(handle) then return nil, "技能槽中存在失效句柄。"
        else
            local nOK, name = call(handle, "GetAbilityName")
            local lOK, level = call(handle, "GetLevel")
            local iOK, abilityIndex = call(handle, "GetAbilityIndex")
            local hOK, hidden = call(handle, "IsHidden")
            local aOK, active = call(handle, "IsActivated")
            local mOK, maximum = call(handle, "GetMaxLevel")
            if not (nOK and lOK and iOK and hOK and aOK and mOK) then return nil, "无法读取原生技能状态。" end
            snapshot.slots[index] = { handle = handle, name = name, index = abilityIndex,
                level = level, maxLevel = maximum, hidden = hidden, active = active }
        end
    end
    return snapshot
end

local function preserved(hero, snapshot, exempt)
    for slot, original in pairs(snapshot.slots) do
        if original.handle ~= exempt then
            local ok, current = call(hero, "GetAbilityByIndex", slot)
            if not ok or current ~= original.handle then return false, "原技能槽位发生变化。" end
            for _, field in ipairs({ { "GetAbilityIndex", "index" }, { "GetLevel", "level" },
                { "IsHidden", "hidden" }, { "IsActivated", "active" } }) do
                local readOK, value = call(current, field[1])
                if not readOK or value ~= original[field[2]] then return false, "其他技能状态发生变化。" end
            end
        end
    end
    return true
end

local function state(requestId, success, errorMessage)
    local result = { requestId = tostring(requestId or "console"), ok = success ~= false,
        error = errorMessage or "", revision = revision, hero = { name = "", unitName = "" }, skills = {} }
    local ctx = context(false)
    if ctx then
        local _, name = call(ctx.hero, "GetUnitName")
        result.hero = { name = tostring(name or ""), unitName = tostring(name or "") }
        local snapshot = inspect(ctx.hero)
        if snapshot then
            result.slotCount, result.emptySlots = snapshot.count, #snapshot.empty
            for index = 0, snapshot.count - 1 do
                local skill = snapshot.slots[index]
                if skill then
                    local owned = ownedEntry(ctx.hero, skill.name) ~= nil
                    table.insert(result.skills, { name = skill.name, index = skill.index, level = skill.level,
                        maxLevel = skill.maxLevel, hidden = skill.hidden, active = skill.active,
                        owned = owned, readonly = not owned,
                        localizationToken = "#DOTA_Tooltip_ability_" .. skill.name })
                end
            end
        end
    end
    local entries = catalog(view)
    if entries then result.catalog = entries end
    if pending then result.pending = { ability = pending.name, stage = "precache" } end
    return result
end

local function publish(host, requestId, success, reason)
    local result = state(requestId, success, reason)
    if valid(host) then call(CustomGameEventManager, "Send_ServerToPlayer", host, RESPONSE, result) end
    log(success and "OK" or "REFUSED", reason or "")
    return result
end

local function doAdd(ctx, entry, requestedLevel)
    local existsOK, existing = call(ctx.hero, "FindAbilityByName", entry.name)
    if not existsOK or existing ~= nil then return false, "已存在同名技能，不能覆盖。" end
    local before, reason = inspect(ctx.hero)
    if not before then return false, reason end
    if #before.empty == 0 then return false, "没有可用的空技能槽。" end
    local ok, ability = call(ctx.hero, "AddAbility", entry.name)
    if not ok or not valid(ability) then
        local foundOK, partial = call(ctx.hero, "FindAbilityByName", entry.name)
        if foundOK and valid(partial) then
            ownedByHero[ctx.hero] = ownedByHero[ctx.hero] or {}
            ownedByHero[ctx.hero][entry.name] = { handle = partial, partial = true }
        end
        return false, "原生引擎拒绝添加；若有残留，只允许清理该新增实例。"
    end
    ownedByHero[ctx.hero] = ownedByHero[ctx.hero] or {}
    local currentOK, current = call(ctx.hero, "FindAbilityByName", entry.name)
    local nameOK, actualName = call(ability, "GetAbilityName")
    if not currentOK or current ~= ability or not nameOK or actualName ~= entry.name then
        if currentOK and valid(current) then
            ownedByHero[ctx.hero][entry.name] = { handle = current, partial = true }
        end
        return false, "新增实例身份读回失败；不会修改返回的其他技能句柄。"
    end
    ownedByHero[ctx.hero][entry.name] = { handle = ability, partial = false }
    local maxOK, maximum = call(ability, "GetMaxLevel")
    maximum = maxOK and integer(maximum, 0, 128) or nil
    local level = maximum and integer(requestedLevel == nil and (maximum > 0 and 1 or 0) or requestedLevel, 0, maximum)
    local upgraded = level ~= nil and call(ability, "SetLevel", level)
    local readOK, actual = call(ability, "GetLevel")
    local intact, changedReason = preserved(ctx.hero, before)
    if not maximum or not upgraded or not readOK or actual ~= level or not intact then
        call(ctx.hero, "RemoveAbility", entry.name)
        local checkOK, remaining = call(ctx.hero, "FindAbilityByName", entry.name)
        if checkOK and remaining == nil then ownedByHero[ctx.hero][entry.name] = nil
        else ownedByHero[ctx.hero][entry.name].partial = true end
        return false, (changedReason or "技能等级读回失败。") .. " 新增项清理=" .. tostring(checkOK and remaining == nil)
    end
    revision = revision + 1
    log("ADDED", entry.name .. " level=" .. level .. "; effect remains unverified")
    return true, entry.dependencyNote
end

function M.Add(name, options, requestId, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if pending then return false, "已有资源预载请求，请稍候。" end
    local loaded, loadReason = loadDirectory()
    if not loaded then return false, loadReason end
    local entry = abilityName(name) and directory[name] or nil
    if not entry then return false, "本机构建没有这个原生技能定义。" end
    options = type(options) == "table" and options or {}
    if entry.requiresRisk and not checked(options.allowRisk) then return false, "此技能需附属或属于高级项，请先确认风险。" end
    if options.level ~= nil and not integer(options.level, 0, 128) then return false, "技能等级必须是有效整数。" end
    if options.level ~= nil and not entry.maxLevelEstimated and tonumber(options.level) > entry.maxLevel then return false, "等级超出本机 KV 定义的范围。" end
    local requestedLevel = options.level
    local existsOK, existing = call(ctx.hero, "FindAbilityByName", name)
    if not existsOK or existing ~= nil then return false, "已存在同名技能，不能覆盖。" end
    local snapshot, inspectReason = inspect(ctx.hero)
    if not snapshot or #snapshot.empty == 0 then return false, inspectReason or "没有可用的空技能槽。" end
    local sourceHero = options.sourceHero or entry.sourceHero
    if options.sourceHero then
        local matched = false
        for _, source in ipairs(entry.sourceHeroes) do if source == options.sourceHero then matched = true end end
        if not matched then return false, "来源英雄不属于此技能的本机定义。" end
    end
    if options.precache == false then
        if not checked(options.allowRisk) then return false, "跳过资源预载需确认高级风险。" end
        return doAdd(ctx, entry, requestedLevel)
    end
    if sourceHero == "" or cachedHeroes[sourceHero] then return doAdd(ctx, entry, requestedLevel) end
    if not heroDefinitions[sourceHero] or type(PrecacheUnitByNameAsync) ~= "function" then return false, "无法预载来源英雄资源。" end
    generation = generation + 1
    local record = { name = name, ctx = ctx, token = generation, requestId = requestId or "console" }
    pending = record
    local ok, errorMessage = pcall(PrecacheUnitByNameAsync, sourceHero, function()
        cachedHeroes[sourceHero] = true
        if pending ~= record or record.token ~= generation then return end
        pending = nil
        local current, currentReason = context(false)
        if not current or current.host ~= ctx.host or current.hero ~= ctx.hero or current.map ~= ctx.map then
            record.completed, record.success, record.reason = true, false, currentReason or "预载期间英雄已切换；没有添加技能。"
            publish(ctx.host, record.requestId, false, currentReason or "预载期间英雄已切换；没有添加技能。")
            return
        end
        local added, addReason = doAdd(current, entry, requestedLevel)
        record.completed, record.success, record.reason = true, added, addReason
        publish(ctx.host, record.requestId, added, addReason)
    end)
    if not ok then pending = nil return false, "预载请求失败：" .. tostring(errorMessage) end
    if pending == record then
        local modeOK, mode = call(GameRules, "GetGameModeEntity")
        local timerOK = modeOK and call(mode, "SetContextThink", "ChronicleSkillEditor:PrecacheTimeout", function()
            if pending == record then
                pending = nil generation = generation + 1
                publish(ctx.host, record.requestId, false, "资源预载超时；没有添加技能。")
            end
            return nil
        end, 15)
        if not timerOK then pending = nil generation = generation + 1 return false, "无法安排资源预载超时保护。" end
    end
    if record.completed then return record.success, record.reason end
    return true, "正在预载来源英雄资源。"
end

function M.Level(name, level, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if pending then return false, "请先等待资源预载。" end
    local record = abilityName(name) and ownedEntry(ctx.hero, name) or nil
    if not record or record.partial then return false, "只可升级本工具成功添加的当前技能实例。" end
    local maxOK, maximum = call(record.handle, "GetMaxLevel")
    maximum = maxOK and integer(maximum, 0, 128) or nil
    local value = maximum and integer(level, 0, maximum)
    if value == nil then return false, "等级超出这个原生技能的范围。" end
    local before, inspectReason = inspect(ctx.hero)
    if not before then return false, inspectReason end
    local ok = call(record.handle, "SetLevel", value)
    local readOK, actual = call(record.handle, "GetLevel")
    local intact, changedReason = preserved(ctx.hero, before, record.handle)
    if not ok or not readOK or actual ~= value or not intact then return false, changedReason or "技能等级读回失败。" end
    revision = revision + 1
    log("LEVEL", name .. " level=" .. value)
    return true, "等级已更新；效果仍需试玩确认。"
end

function M.Remove(name, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if pending then return false, "请先等待资源预载。" end
    local record = abilityName(name) and ownedEntry(ctx.hero, name) or nil
    if not record then return false, "不能删除原技能或其他来源的技能实例。" end
    local before, inspectReason = inspect(ctx.hero)
    if not before then return false, inspectReason end
    local ok = call(ctx.hero, "RemoveAbility", name)
    local readOK, remaining = call(ctx.hero, "FindAbilityByName", name)
    if not ok or not readOK or remaining ~= nil then return false, "原生删除读回失败。" end
    ownedByHero[ctx.hero][name] = nil
    revision = revision + 1
    local intact, changedReason = preserved(ctx.hero, before, record.handle)
    log("REMOVED", name)
    if not intact then return false, changedReason .. " 新增实例已移除，但不会重写其他原技能。" end
    return true, "新增实例已移除；持续效果和召唤物不做笼统清理。"
end

function M.Search(options)
    local ctx, reason = context(true)
    if not ctx then return nil, reason end
    local entries, errorMessage = catalog(options)
    if entries then
        view = { query = entries.query, category = entries.category, page = entries.page, pageSize = entries.pageSize }
        log("CATALOG", "total=" .. entries.total .. " page=" .. entries.page .. " category=" .. entries.category)
        for _, entry in ipairs(entries.items) do
            log("ENTRY", entry.name .. " category=" .. entry.category .. " source=" .. entry.sourceHero
                .. " risk=" .. tostring(entry.requiresRisk) .. " complexity=" .. entry.complexity)
        end
    end
    return entries, errorMessage
end

function M.Status()
    local ctx, reason = context(true)
    if not ctx then return nil, reason end
    local result = state("console", true)
    log("SNAPSHOT", "hero=" .. result.hero.unitName .. " slots=" .. tostring(result.slotCount)
        .. " empty=" .. tostring(result.emptySlots) .. " revision=" .. revision)
    for _, skill in ipairs(result.skills) do
        log("SLOT", "name=" .. skill.name .. " index=" .. skill.index .. " level=" .. skill.level
            .. " hidden=" .. tostring(skill.hidden) .. " active=" .. tostring(skill.active)
            .. " owned=" .. tostring(skill.owned) .. " readonly=" .. tostring(skill.readonly))
    end
    return result
end

function M.ClosePanel(rpcHost)
    local host, reason
    if rpcHost then host = rpcHost else host, reason = hostGuard(false, true) end
    if not host then return false, reason end
    generation = generation + 1
    pending = nil
    panelReady = false
    if panelHost then
        if panelHost ~= host then return false, "面板不属于当前本机玩家。" end
        local idOK, playerID = call(host, "GetPlayerID")
        if not idOK then return false, "无法核实面板归属。" end
        local ok = call(CustomUI, "DynamicHud_Destroy", playerID, HUD)
        if not ok then return false, "独立面板关闭请求失败。" end
        panelHost = nil
    end
    print("CHRONICLE_SKILL_EDITOR_PANEL closed")
    return true, "面板已关闭；已添加技能保留在当前试玩中。"
end

function M.OpenPanel()
    local ctx, reason = context(true)
    if not ctx then return false, reason end
    if panelHost == ctx.host then print("CHRONICLE_SKILL_EDITOR_PANEL already_requested") return true, "面板已请求打开。" end
    panelReady = false
    local ok = call(CustomUI, "DynamicHud_Create", ctx.playerID, HUD, LAYOUT, {})
    if not ok then return false, "此构建无法请求动态面板。" end
    panelHost = ctx.host
    print("CHRONICLE_SKILL_EDITOR_PANEL requested; client rendering unverified")
    publish(ctx.host, "panel", true)
    return true, "独立面板加载已请求；实际画面待客户端确认。"
end

function M.TogglePanel()
    if panelHost then return M.ClosePanel() end
    return M.OpenPanel()
end

function M.HandleRequest(source, payload)
    local host = hostGuard(false, false)
    if not host or type(EntIndexToHScript) ~= "function" then return false end
    local index = integer(source, 1, 1000000)
    if not index then log("RPC_SOURCE", "invalid source_type=" .. type(source)) return false end
    local sourceOK, sender = pcall(EntIndexToHScript, index)
    if not sourceOK or sender ~= host then log("REFUSED", "foreign UI source") return false end
    log("RPC_SOURCE", "source_type=" .. type(source) .. " matches_local_host=true")
    -- Engine event source is authoritative. payload.PlayerID is deliberately ignored.
    if type(payload) ~= "table" then return false end
    local requestId = payload.requestId
    if type(requestId) ~= "string" or #requestId > 64 or requestId:find("[%c]") then return false end
    local action = payload.action
    if action == "close" then
        local ok, reason = M.ClosePanel(host)
        publish(host, requestId, ok, reason)
        return ok
    end
    local ctx, reason = context(false)
    if not ctx or ctx.host ~= sender then publish(host, requestId, false, reason or "本机上下文已改变。") return false end
    local ok, errorMessage = true, nil
    if action == "snapshot" then
        -- The authoritative snapshot is constructed below.
        if panelHost == ctx.host and not panelReady then
            panelReady = true
            print("CHRONICLE_SKILL_EDITOR_UI_READY authenticated native panel snapshot")
        end
    elseif action == "catalog" then
        local entries, searchReason = catalog(payload)
        ok, errorMessage = entries ~= nil, searchReason
        if entries then view = { query = entries.query, category = entries.category, page = entries.page, pageSize = entries.pageSize } end
    elseif action == "add" then ok, errorMessage = M.Add(payload.ability, payload, requestId, ctx)
    elseif action == "level" then ok, errorMessage = M.Level(payload.ability, payload.level, ctx)
    elseif action == "remove" then ok, errorMessage = M.Remove(payload.ability, ctx)
    else ok, errorMessage = false, "未知操作。" end
    publish(host, requestId, ok, errorMessage)
    return ok
end

function M.Register()
    if type(IsServer) ~= "function" or not IsServer() or type(FCVAR_CHEAT) ~= "number" then return false, "服务端注册接口缺失。" end
    local function optional(value) return value ~= "" and value or nil end
    local function consoleCatalog(_, query, category, page, ...)
        log("CATALOG_ARGS", "extra=" .. select("#", ...) .. " query_type=" .. type(query)
            .. " query_bytes=" .. (type(query) == "string" and #query or 0)
            .. " category_type=" .. type(category) .. " category_bytes=" .. (type(category) == "string" and #category or 0))
        query, category, page = optional(query) or "", optional(category), optional(page)
        -- Support a category-first convenience form without changing the GUI
        -- protocol; omitted native console arguments can be empty strings.
        if categories[query] and not categories[category] then query, category = category or "", query end
        local result, reason = M.Search({ query = query, category = category or "default", page = page or 1 })
        if result then publish(hostGuard(true, true), "console", true) else log("REFUSED", reason) end
        return result ~= nil
    end
    local commands = {
        { "chronicle_skill_panel", function(_, mode) if mode == "open" then return M.OpenPanel() elseif mode == "close" then return M.ClosePanel() elseif mode == nil then return M.TogglePanel() end return false, "参数应为 open 或 close。" end },
        { "chronicle_skill_status", function() local result, reason = M.Status() if result then publish(hostGuard(true, true), "console", true) else log("REFUSED", reason) end return result ~= nil end },
        { "chronicle_skill_search", consoleCatalog },
        { "chronicle_skill_add", function(_, name, level, risk) local host = hostGuard(true, true) local ok, reason = M.Add(name, { level = optional(level), allowRisk = risk == "risk" }, "console") publish(host, "console", ok, reason) return ok end },
        { "chronicle_skill_level", function(_, name, level) local host = hostGuard(true, true) local ok, reason = M.Level(name, level) publish(host, "console", ok, reason) return ok end },
        { "chronicle_skill_remove", function(_, name) local host = hostGuard(true, true) local ok, reason = M.Remove(name) publish(host, "console", ok, reason) return ok end },
        { "chronicle_skill_catalog", consoleCatalog },
        { "chronicle_skill_snapshot", function() local result, reason = M.Status() if result then publish(hostGuard(true, true), "console", true) else log("REFUSED", reason) end return result ~= nil end },
    }
    for _, command in ipairs(commands) do
        if not registered[command[1]] then
            local action = command[2]
            local callback = function(...)
                local ok, success, reason = pcall(action, ...)
                if not ok then log("ERROR", success) return false end
                if success == false then log("REFUSED", reason or "操作被拒绝。") end
                return success
            end
            local ok, reason = call(Convars, "RegisterCommand", command[1], callback, "Local native hero-demo skill editor.", FCVAR_CHEAT)
            if not ok then return false, reason end
            registered[command[1]] = true
            log("COMMAND_REGISTERED", command[1])
        end
    end
    if listener == nil then
        local ok, id = call(CustomGameEventManager, "RegisterListener", REQUEST, function(source, payload) M.HandleRequest(source, payload) end)
        if not ok or id == nil then return false, "无法注册面板请求监听。" end
        listener = id
    end
    return true
end

M.protocol = { requestEvent = REQUEST, responseEvent = RESPONSE, hud = HUD, layout = LAYOUT }
_G[KEY] = M
print("CHRONICLE_SKILL_EDITOR_LOADED v1; native hero_demo only; complex skill effects unverified")
local registeredOK, registeredReason = M.Register()
if not registeredOK then log("REFUSED", registeredReason) end
return M

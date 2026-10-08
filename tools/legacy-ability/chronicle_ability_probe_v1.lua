-- Original Dota Chronicle research tool; no Valve scripts are copied here.
-- Lua 5.1-compatible. Runtime validation is required on each client build.
-- This module never invokes Activate or rewrites the native hero's abilities.

local MODULE_KEY = "__chronicle_ability_probe_v1"
if _G[MODULE_KEY] then
    print("CHRONICLE_ABILITY_REUSE")
    return _G[MODULE_KEY]
end

local M = { version = 1 }
local ordinaryTest = false
local owned = {}
local registered = {}
local supportedAbility = "sven_storm_bolt"
local supportedHero = "npc_dota_hero_sven"
local precached = false
local precachePending = false
local targetPrecached = {}
local targetPrecachePending = false
local fixture = nil
local resultThinkName = "ChronicleAbilityProbe:CastResult"
local targetTimeoutName = "ChronicleAbilityProbe:TargetTimeout"
local castGeneration = 0

local function emit(marker, detail)
    print("CHRONICLE_ABILITY_" .. marker .. (detail and (" " .. tostring(detail)) or ""))
end

local function invoke(object, name, ...)
    if object == nil then return false, "missing object: " .. name end
    local ok, method = pcall(function() return object[name] end)
    if not ok or type(method) ~= "function" then return false, "missing method: " .. name end
    return pcall(method, object, ...)
end

local function valid(handle)
    if handle == nil then return false end
    local ok, isNull = invoke(handle, "IsNull")
    return ok and isNull == false
end

local function localHost(cleanupOnly)
    if type(IsServer) ~= "function" or not IsServer() then return nil, "server Lua required" end
    if type(IsDedicatedServer) ~= "function" or IsDedicatedServer() then
        return nil, "local listen server required"
    end
    if not cleanupOnly then
        local ok, cheats = invoke(Convars, "GetBool", "sv_cheats")
        if not ok or cheats ~= true then return nil, "sv_cheats 1 required" end
    end
    if type(GetListenServerHost) ~= "function" then return nil, "listen host API unavailable" end
    local hostOK, host = pcall(GetListenServerHost)
    if not hostOK or not valid(host) then return nil, "no local listen host" end
    local issuerOK, issuer = invoke(Convars, "GetCommandClient")
    if not issuerOK then return nil, "command issuer API unavailable" end
    -- A nil issuer represents a server-console call. A remote player is refused.
    if issuer ~= nil and issuer ~= host then return nil, "only the local host may use this tool" end
    return host
end

local function context()
    local host, reason = localHost()
    if not host then return nil, reason end
    local demo = GameRules ~= nil and type(GameRules.herodemo) == "table"
    local mapOK, mapName = false, nil
    if type(GetMapName) == "function" then mapOK, mapName = pcall(GetMapName) end
    if not demo and not (ordinaryTest and mapOK and mapName == "dota") then
        return nil, "hero_demo or explicitly enabled local dota test required"
    end
    local heroOK, hero = invoke(host, "GetAssignedHero")
    if not heroOK or not valid(hero) then return nil, "local hero is not ready" end
    local realOK, real = invoke(hero, "IsRealHero")
    if not realOK or not real then return nil, "real hero required" end
    local idOK, playerID = invoke(host, "GetPlayerID")
    local ownerOK, ownerID = invoke(hero, "GetPlayerOwnerID")
    if not idOK or not ownerOK or playerID ~= ownerID then return nil, "hero owner mismatch" end
    return hero
end

local function reject(reason)
    emit("REFUSED", reason)
    return false, reason
end

local function inspect(hero)
    local ok, count = invoke(hero, "GetAbilityCount")
    if not ok or type(count) ~= "number" or count ~= math.floor(count) or count < 1 or count > 64 then
        return nil, "invalid or unavailable ability slot count"
    end
    local snapshot = { count = count, slots = {}, empty = {} }
    for index = 0, count - 1 do
        local slotOK, ability = invoke(hero, "GetAbilityByIndex", index)
        if not slotOK then return nil, "cannot inspect slot " .. index end
        if ability == nil then
            table.insert(snapshot.empty, index)
        elseif not valid(ability) then
            return nil, "invalid ability handle in slot " .. index
        else
            local nameOK, name = invoke(ability, "GetAbilityName")
            local indexOK, abilityIndex = invoke(ability, "GetAbilityIndex")
            local hiddenOK, hidden = invoke(ability, "IsHidden")
            local activeOK, active = invoke(ability, "IsActivated")
            local levelOK, level = invoke(ability, "GetLevel")
            if not (nameOK and indexOK and hiddenOK and activeOK and levelOK) then
                return nil, "cannot inspect ability state in slot " .. index
            end
            snapshot.slots[index] = {
                handle = ability, name = name, index = abilityIndex,
                hidden = hidden, active = active, level = level,
            }
        end
    end
    return snapshot
end

local function unchanged(hero, snapshot)
    for slot, original in pairs(snapshot.slots) do
        local ok, current = invoke(hero, "GetAbilityByIndex", slot)
        if not ok or current ~= original.handle then return false, "native slot changed: " .. slot end
        local indexOK, index = invoke(current, "GetAbilityIndex")
        local hiddenOK, hidden = invoke(current, "IsHidden")
        local activeOK, active = invoke(current, "IsActivated")
        local levelOK, level = invoke(current, "GetLevel")
        if not (indexOK and hiddenOK and activeOK and levelOK) or index ~= original.index
            or hidden ~= original.hidden or active ~= original.active or level ~= original.level then
            return false, "native ability state changed: " .. original.name
        end
    end
    return true
end

local function ownedEntry(hero, name)
    local entry = owned[name]
    if not entry or entry.hero ~= hero or not valid(entry.ability) then return nil end
    local ok, current = invoke(hero, "FindAbilityByName", name)
    if not ok or current ~= entry.ability then return nil end
    return entry
end

function M.EnableOrdinaryTest(enabled)
    if enabled == false then
        if fixture then return reject("clear the module's target before disabling ordinary test") end
        ordinaryTest = false
        emit("ORDINARY_TEST", "disabled")
        return true
    end
    if enabled ~= true then return reject("pass the explicit boolean true or false") end
    local host, reason = localHost()
    if not host then return reject(reason) end
    local ok, mapName = false, nil
    if type(GetMapName) == "function" then ok, mapName = pcall(GetMapName) end
    if not ok or mapName ~= "dota" then return reject("ordinary test requires map dota") end
    ordinaryTest = true
    emit("ORDINARY_TEST", "enabled for this Lua VM only")
    return true
end

function M.Status()
    local hero, reason = context()
    if not hero then return reject(reason) end
    local snapshot, errorMessage = inspect(hero)
    if not snapshot then return reject(errorMessage) end
    local _, name = invoke(hero, "GetUnitName")
    emit("STATUS", "hero=" .. tostring(name) .. " slots=" .. snapshot.count
        .. " precached=" .. tostring(precached) .. " pending=" .. tostring(precachePending))
    for index = 0, snapshot.count - 1 do
        local slot = snapshot.slots[index]
        if slot then
            emit("SLOT", "index=" .. index .. " name=" .. slot.name .. " level=" .. slot.level
                .. " hidden=" .. tostring(slot.hidden) .. " active=" .. tostring(slot.active)
                .. " added=" .. tostring(ownedEntry(hero, slot.name) ~= nil))
        else
            emit("SLOT", "index=" .. index .. " empty=true")
        end
    end
    return true, snapshot
end

M.List = M.Status

function M.Environment()
    local mapName, server = "unknown", "unknown"
    if type(GetMapName) == "function" then
        local ok, value = pcall(GetMapName)
        if ok then mapName = tostring(value) end
    end
    if type(IsServer) == "function" then
        local ok, value = pcall(IsServer)
        if ok then server = tostring(value) end
    end
    emit("ENV", "map=" .. mapName .. " IsServer=" .. server
        .. " GameRules=" .. type(GameRules) .. " herodemo=" .. type(GameRules and GameRules.herodemo)
        .. " Convars=" .. type(Convars) .. " require=" .. type(require)
        .. " GetListenServerHost=" .. type(GetListenServerHost)
        .. " CreateUnitByName=" .. type(CreateUnitByName)
        .. " PrecacheUnitByNameAsync=" .. type(PrecacheUnitByNameAsync)
        .. " ordinary_authorized=" .. tostring(ordinaryTest))
    return true
end

function M.Precache(name)
    if name ~= supportedHero then return reject("precache allowlist: " .. supportedHero) end
    local hero, reason = context()
    if not hero then return reject(reason) end
    if precached then emit("PRECACHE_READY", name) return true end
    if precachePending then return reject("precache is already pending") end
    if type(PrecacheUnitByNameAsync) ~= "function" then return reject("async precache API unavailable") end
    precachePending = true
    local ok, errorMessage = pcall(PrecacheUnitByNameAsync, name, function()
        precachePending = false
        precached = true
        emit("PRECACHE_READY", name)
    end)
    if not ok then precachePending = false return reject(errorMessage) end
    emit("PRECACHE_REQUESTED", name)
    return true
end

function M.Add(name)
    if name ~= supportedAbility then return reject("ability allowlist: " .. supportedAbility) end
    local hero, reason = context()
    if not hero then return reject(reason) end
    local foundOK, existing = invoke(hero, "FindAbilityByName", name)
    if not foundOK then return reject("cannot inspect existing ability") end
    if existing ~= nil then return reject("ability already exists; no replacement") end
    if not precached then return reject("precache Sven first and wait for PRECACHE_READY") end
    local snapshot, errorMessage = inspect(hero)
    if not snapshot then return reject(errorMessage) end
    if #snapshot.empty == 0 then return reject("no verified empty ability slot") end
    local addOK, ability = invoke(hero, "AddAbility", name)
    if not addOK or not valid(ability) then
        -- Retain ownership if the native call partly succeeded before reporting an error.
        local afterOK, after = invoke(hero, "FindAbilityByName", name)
        if afterOK and valid(after) then
            owned[name] = { hero = hero, ability = after, original = snapshot, partial = true }
            emit("ADD_PARTIAL", "tracked for removal only: " .. name)
        end
        return reject("native AddAbility failed")
    end
    owned[name] = { hero = hero, ability = ability, original = snapshot }
    local preserved, changedReason = unchanged(hero, snapshot)
    if not preserved then
        emit("NATIVE_STATE_CHANGED", changedReason)
        local cleanupOK, cleanupReason = M.Remove(name)
        local checkOK, remaining = invoke(hero, "FindAbilityByName", name)
        local removed = checkOK and remaining == nil
        emit(removed and "ADD_CLEANUP_REMOVED" or "ADD_CLEANUP_FAILED", name)
        return reject("add rejected; added item removed=" .. tostring(removed)
            .. "; native state preserved=" .. tostring(cleanupOK)
            .. (cleanupReason and ("; " .. tostring(cleanupReason)) or ""))
    end
    local indexOK, index = invoke(ability, "GetAbilityIndex")
    local hiddenOK, hidden = invoke(ability, "IsHidden")
    local activeOK, active = invoke(ability, "IsActivated")
    emit("ADDED", name .. " index=" .. tostring(indexOK and index or "unknown")
        .. " hidden=" .. tostring(hiddenOK and hidden) .. " active=" .. tostring(activeOK and active))
    -- Do not swap abilities or force hidden/activated states to make the icon appear.
    if not indexOK or index > 5 or not hiddenOK or hidden or not activeOK or not active then
        emit("VISIBILITY_UNCONFIRMED", "native HUD may not show the added ability; no slots were rearranged")
    end
    return true, ability
end

function M.Level(name, requestedLevel)
    if name ~= supportedAbility then return reject("ability allowlist: " .. supportedAbility) end
    local hero, reason = context()
    if not hero then return reject(reason) end
    local entry = ownedEntry(hero, name)
    if not entry then return reject("only the module's current added ability can be leveled") end
    if entry.partial then return reject("partial native add is tracked for removal only") end
    local level = tonumber(requestedLevel)
    local maxOK, maximum = invoke(entry.ability, "GetMaxLevel")
    if not maxOK or type(maximum) ~= "number" or maximum ~= math.floor(maximum)
        or maximum < 1 or maximum > 4 then
        return reject("unexpected maximum level for Sven Storm Hammer")
    end
    if not level or level ~= math.floor(level) or level < 1 or level > maximum then
        return reject("level must be an integer in 1.." .. maximum)
    end
    local ok, errorMessage = invoke(entry.ability, "SetLevel", level)
    if not ok then return reject(errorMessage) end
    local readOK, actual = invoke(entry.ability, "GetLevel")
    if not readOK or actual ~= level then return reject("native level readback mismatch") end
    emit("LEVEL", name .. " level=" .. actual)
    return true
end

function M.Remove(name)
    if name ~= supportedAbility then return reject("ability allowlist: " .. supportedAbility) end
    local hero, reason = context()
    if not hero then return reject(reason) end
    local entry = ownedEntry(hero, name)
    if not entry then return reject("only the module's current added ability can be removed") end
    local ok, errorMessage = invoke(hero, "RemoveAbility", name)
    if not ok then return reject(errorMessage) end
    local checkOK, remaining = invoke(hero, "FindAbilityByName", name)
    if not checkOK or remaining ~= nil then return reject("native removal readback mismatch") end
    owned[name] = nil
    local preserved, changedReason = unchanged(hero, entry.original)
    emit("REMOVED", name)
    if not preserved then emit("NATIVE_STATE_CHANGED", changedReason) end
    return preserved, changedReason
end

function M.TestResult(stage)
    local hero, reason = context()
    if not hero then return reject(reason) end
    if not fixture or fixture.hero ~= hero or not fixture.beforeMana then
        return reject("no cast record for this local hero")
    end
    local entry = ownedEntry(hero, supportedAbility)
    if not entry or entry.ability ~= fixture.ability or not valid(fixture.target) then
        return reject("cast ability or module target is no longer available")
    end
    local manaOK, mana = invoke(hero, "GetMana")
    local hpOK, hp = invoke(fixture.target, "GetHealth")
    local stunOK, stunned = invoke(fixture.target, "IsStunned")
    local cooldownOK, cooldown = invoke(entry.ability, "GetCooldownTimeRemaining")
    local complete = manaOK and hpOK and stunOK and cooldownOK
        and type(mana) == "number" and type(hp) == "number"
        and type(stunned) == "boolean" and type(cooldown) == "number"
    emit("CAST_RESULT", "sample=" .. tostring(stage or "manual") .. " readbacks=" .. tostring(complete)
        .. " mana_before=" .. fixture.beforeMana .. " mana_after=" .. tostring(manaOK and mana or "unknown")
        .. " hp_before=" .. fixture.beforeHP .. " hp_after=" .. tostring(hpOK and hp or "unknown")
        .. " stunned=" .. tostring(stunOK and stunned) .. " cooldown=" .. tostring(cooldownOK and cooldown or "unknown"))
    return complete
end

local function cleanupFixture(record, host)
    -- This record contains only the exact unit created by this module.
    -- Removing that unit does not require gameplay permissions to remain enabled.
    if fixture ~= record then return false end
    local heroOK, hero = invoke(host, "GetAssignedHero")
    local mapOK, mapName = false, nil
    if type(GetMapName) == "function" then mapOK, mapName = pcall(GetMapName) end
    local idOK, playerID = invoke(host, "GetPlayerID")
    local ownerOK, ownerID = invoke(hero, "GetPlayerOwnerID")
    local sameHero = heroOK and valid(hero) and hero == record.hero and host == record.host
        and mapOK and mapName == record.mapName and idOK and ownerOK and playerID == ownerID
    if sameHero then
        invoke(hero, "SetContextThink", resultThinkName, nil, 0)
    end
    local removed = not valid(record.target)
    if not removed then
        local ok, errorMessage = invoke(record.target, "Destroy")
        if not ok then return reject("own target cleanup failed: " .. tostring(errorMessage)) end
        removed = not valid(record.target)
    end
    local restored = not record.heroMoved
    if record.heroMoved and sameHero and type(FindClearSpaceForUnit) == "function" then
        local moveOK = pcall(FindClearSpaceForUnit, hero, record.origin, false)
        local facingOK = invoke(hero, "SetForwardVector", record.forward)
        restored = moveOK and facingOK
        if restored then record.heroMoved = false end
    end
    emit("TARGET_CLEAR", "own_target_removed=" .. tostring(removed) .. " same_hero=" .. tostring(sameHero)
        .. " position_restore_requested=" .. tostring(restored))
    if removed and (restored or not sameHero) then fixture = nil end
    return removed and (restored or not sameHero)
end

function M.ClearTarget()
    local host, reason = localHost(true)
    if not host then return reject(reason) end
    castGeneration = castGeneration + 1
    if not fixture then
        emit("TARGET_CLEAR", "no module target; pending cast intent cancelled")
        return true
    end
    return cleanupFixture(fixture, host)
end

function M.TestCast()
    local hero, reason = context()
    if not hero then return reject(reason) end
    local entry = ownedEntry(hero, supportedAbility)
    if not entry or entry.partial then return reject("a successfully added own Storm Hammer is required") end
    local levelOK, level = invoke(entry.ability, "GetLevel")
    local activeOK, active = invoke(entry.ability, "IsActivated")
    local cooldownOK, cooldown = invoke(entry.ability, "GetCooldownTimeRemaining")
    if not levelOK or type(level) ~= "number" or level < 1 or level > 4 then return reject("level the own ability first") end
    if not activeOK or not active or not cooldownOK or type(cooldown) ~= "number" or cooldown > 0 then
        return reject("own ability must be activated and off cooldown")
    end
    if fixture then return reject("clear the previous module target first") end
    local teamOK, team = invoke(hero, "GetTeamNumber")
    if not teamOK or (team ~= 2 and team ~= 3) then return reject("Radiant or Dire local hero required") end
    local enemyTeam = team == 2 and 3 or 2
    local unitName = team == 2 and "npc_dota_creep_badguys_melee" or "npc_dota_creep_goodguys_melee"
    if not targetPrecached[unitName] then
        if targetPrecachePending then return reject("target precache is pending") end
        if type(PrecacheUnitByNameAsync) ~= "function" then return reject("target precache API unavailable") end
        targetPrecachePending = true
        castGeneration = castGeneration + 1
        local generation = castGeneration
        local ok, errorMessage = pcall(PrecacheUnitByNameAsync, unitName, function()
            targetPrecachePending = false
            targetPrecached[unitName] = true
            emit("TARGET_PRECACHE_READY", unitName)
            if generation ~= castGeneration then emit("CAST_CANCELLED", "pending cast intent was cleared") return end
            local current = context()
            if current == hero then M.TestCast() else emit("CAST_CANCELLED", "local hero or context changed during precache") end
        end)
        if not ok then targetPrecachePending = false return reject(errorMessage) end
        emit("TARGET_PRECACHE_REQUESTED", unitName)
        return true, "target precache requested; cast is not yet verified"
    end
    if type(CreateUnitByName) ~= "function" or type(Vector) ~= "function"
        or type(FindClearSpaceForUnit) ~= "function" then return reject("target placement APIs unavailable") end
    local originOK, origin = invoke(hero, "GetAbsOrigin")
    local forwardOK, forward = invoke(hero, "GetForwardVector")
    local manaOK, mana = invoke(hero, "GetMana")
    if not originOK or not forwardOK or not manaOK or type(mana) ~= "number" then return reject("cannot snapshot local hero") end
    local copyOK, savedOrigin, savedForward = pcall(function()
        return Vector(origin.x, origin.y, origin.z), Vector(forward.x, forward.y, forward.z)
    end)
    if not copyOK then return reject("cannot copy original hero position") end
    local host, hostReason = localHost()
    local mapOK, mapName = false, nil
    if type(GetMapName) == "function" then mapOK, mapName = pcall(GetMapName) end
    if not host or not mapOK then return reject(hostReason or "cannot snapshot current map") end
    local center, targetPosition = Vector(-4500, -2300, 128), Vector(-4200, -2300, 128)
    local spawnOK, target = pcall(CreateUnitByName, unitName, targetPosition, true, nil, nil, enemyTeam)
    if not spawnOK or not valid(target) then return reject("could not create independent target") end
    fixture = { hero = hero, target = target, ability = entry.ability,
        host = host, mapName = mapName, origin = savedOrigin, forward = savedForward, heroMoved = false }
    local regenOK = invoke(target, "SetBaseHealthRegen", 0)
    local rootOK, rooted = invoke(target, "AddNewModifier", target, nil, "modifier_rooted", { duration = 60 })
    local disarmOK, disarmed = invoke(target, "AddNewModifier", target, nil, "modifier_disarmed", { duration = 60 })
    local idleOK = invoke(target, "SetIdleAcquire", false)
    local rangeOK = invoke(target, "SetAcquisitionRange", 0)
    if not (regenOK and rootOK and valid(rooted) and disarmOK and valid(disarmed) and idleOK and rangeOK) then
        M.ClearTarget()
        return reject("cannot isolate the module's target")
    end
    local record = fixture
    local timeoutOK = invoke(target, "SetContextThink", targetTimeoutName, function()
        if fixture == record then
            castGeneration = castGeneration + 1
            emit("TARGET_TIMEOUT", "cleaning the module's own target")
            local restoreHost = localHost(true)
            cleanupFixture(record, restoreHost)
        end
        return nil
    end, 10)
    if not timeoutOK then M.ClearTarget() return reject("cannot schedule own-target safety cleanup") end
    fixture.heroMoved = true
    local moveOK = pcall(FindClearSpaceForUnit, hero, center, false)
    local hpOK, hp = invoke(target, "GetHealth")
    if not moveOK or not hpOK or type(hp) ~= "number" then
        M.ClearTarget()
        return reject("target placement or health snapshot failed")
    end
    fixture.beforeMana, fixture.beforeHP = mana, hp
    local idOK, playerID = invoke(hero, "GetPlayerOwnerID")
    if not idOK then M.ClearTarget() return reject("no local cast owner") end
    local castOK, errorMessage = invoke(hero, "CastAbilityOnTarget", target, entry.ability, playerID)
    if not castOK then M.ClearTarget() return reject("engine cast order failed: " .. tostring(errorMessage)) end
    emit("CAST_ORDER", "sven_storm_bolt; mana_before=" .. mana .. " hp_before=" .. hp .. "; outcome unverified")
    local sample = 0
    local thinkOK, thinkError = invoke(hero, "SetContextThink", resultThinkName, function()
        if fixture ~= record then return nil end
        local current = context()
        if current ~= record.hero then
            emit("CAST_CANCELLED", "local context changed before result readback")
            local restoreHost = localHost(true)
            cleanupFixture(record, restoreHost)
            return nil
        end
        sample = sample + 1
        M.TestResult(sample == 1 and "0.7s" or "1.0s")
        if sample == 1 then return 0.3 end
        return nil
    end, 0.7)
    if not thinkOK then emit("CAST_READBACK_UNSCHEDULED", thinkError .. "; use chronicle_ability_cast_result") end
    return true, "engine cast order issued; result readbacks still required"
end

function M.RegisterCommands()
    if type(IsServer) ~= "function" or not IsServer() then return reject("server Lua required") end
    if Convars == nil or type(FCVAR_CHEAT) ~= "number" then return reject("cheat command API unavailable") end
    local commands = {
        { "chronicle_ability_env", function(_, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_env") end return M.Environment() end, "Report local Lua API types without identity data." },
        { "chronicle_ability_test", function(_, mode, ...) if mode ~= "ordinary" or select("#", ...) ~= 0 then return reject("usage: chronicle_ability_test ordinary") end return M.EnableOrdinaryTest(true) end, "Explicitly authorize the local ordinary dota test context." },
        { "chronicle_ability_precache", function(_, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_precache") end return M.Precache(supportedHero) end, "Precache only the allowlisted Sven hero." },
        { "chronicle_ability_list", function(_, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_list") end return M.List() end, "Inspect local test hero ability slots." },
        { "chronicle_ability_add", function(_, name, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_add sven_storm_bolt") end return M.Add(name) end, "Add the allowlisted test ability without replacing native abilities." },
        { "chronicle_ability_level", function(_, name, level, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_level sven_storm_bolt 1") end return M.Level(name, level) end, "Set the module-added test ability level within native bounds." },
        { "chronicle_ability_remove", function(_, name, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_remove sven_storm_bolt") end return M.Remove(name) end, "Remove only the exact ability handle added by this module." },
        { "chronicle_ability_cast", function(_, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_cast") end return M.TestCast() end, "Issue a real engine cast order against one isolated module-owned target." },
        { "chronicle_ability_cast_result", function(_, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_cast_result") end return M.TestResult() end, "Read back test mana, target health, stun and cooldown." },
        { "chronicle_ability_target_clear", function(_, ...) if select("#", ...) ~= 0 then return reject("usage: chronicle_ability_target_clear") end return M.ClearTarget() end, "Clear only the module's own target and request same-hero position restoration." },
    }
    for _, command in ipairs(commands) do
        if not registered[command[1]] then
            local ok, errorMessage = invoke(Convars, "RegisterCommand", command[1], command[2], command[3], FCVAR_CHEAT)
            if not ok then return reject(errorMessage) end
            registered[command[1]] = true
            emit("COMMAND_REGISTERED", command[1])
        end
    end
    return true
end

_G[MODULE_KEY] = M
emit("LOADED", "v1; allowlist=sven_storm_bolt; runtime unverified")
M.Environment()
M.RegisterCommands()
return M

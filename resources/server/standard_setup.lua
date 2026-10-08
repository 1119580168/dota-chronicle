-- Run once on an empty native All Pick server, before accepting players.
local tag = '[Old732StandardSetup] '
if not IsServer() or not IsDedicatedServer() or GetMapName() ~= 'dota'
    or tostring(GameRules:GetGameSessionConfigValue('gamemode', '')) ~= '1'
    or GameRules:GetGameSessionConfigValue('customgamemode', '') ~= '' then
    error(tag .. 'refused: not the configured ordinary All Pick server')
end
if GameRules:State_Get() ~= DOTA_GAMERULES_STATE_HERO_SELECTION then
    error(tag .. 'refused: not at initial hero selection')
end
for id = 0, 23 do
    if PlayerResource:IsValidPlayerID(id) then error(tag .. 'refused: a game seat already exists') end
end
for _, player in ipairs(Entities:FindAllByClassname('dota_player_controller')) do
    error(tag .. 'refused: a network player already exists')
end
if GameRules.__codexOld732StandardSetup then error(tag .. 'refused: already installed') end
GameRules.__codexOld732StandardSetup = true
-- Reset only before players/picks; it discards the mode entity immediately.
-- Ordinary mode must not use the Workshop CUSTOM_GAME_SETUP think adapter.
-- Native AP uses its own picker timer in addition to GameRules' phase timer.
-- Reset constructs that picker while the startup command has cheats enabled;
-- the launcher restores cheats=0 and the cvar default immediately afterward.
Convars:SetFloat('dota_heropicker_ap_select_time', 3600)
GameRules:SetHeroSelectionTime(3600)
GameRules:ResetToHeroSelection()
print(tag .. 'armed: mode=1 selectionSeconds=3600 state=' .. GameRules:State_Get())

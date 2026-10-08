-- Optional native-bot test: real humans must join teams before population.
local tag = '[Old732StandardBots] '
if not IsServer() or not IsDedicatedServer() or GetMapName() ~= 'dota'
    or tostring(GameRules:GetGameSessionConfigValue('gamemode', '')) ~= '1'
    or GameRules:GetGameSessionConfigValue('customgamemode', '') ~= ''
    or GameRules:State_Get() ~= DOTA_GAMERULES_STATE_HERO_SELECTION then
    error(tag .. 'refused: not ordinary All Pick hero selection')
end
if GameRules.__codexOld732StandardBots then error(tag .. 'refused: already populated') end
local humans, bots = 0, 0
for id = 0, 23 do
    if PlayerResource:IsValidPlayerID(id) then
        if PlayerResource:IsFakeClient(id) then
            bots = bots + 1
        elseif not PlayerResource:IsBroadcaster(id) then
            local team = PlayerResource:GetTeam(id)
            if (team ~= DOTA_TEAM_GOODGUYS and team ~= DOTA_TEAM_BADGUYS)
                or PlayerResource:GetConnectionState(id) ~= 2 or not PlayerResource:GetPlayer(id) then
                error(tag .. 'refused: a human seat is not ready')
            end
            humans = humans + 1
        end
    end
end
if humans < 1 or humans > 9 or bots ~= 0 then
    error(tag .. 'refused: need 1-9 connected team-assigned humans and zero bots')
end
GameRules.__codexOld732StandardBots = true
SendToServerConsole('dota_bot_populate')
print(tag .. 'requested: humans=' .. humans .. ' targetBots=' .. (10 - humans))

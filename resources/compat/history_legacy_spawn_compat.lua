-- Compatibility for the original Frostivus callback form in build 901.
-- Native entity creation, original map, waves, heroes and numbers are retained.
if not HistoryLegacySpawnCompat then
    local nativeSpawn = SpawnEntityFromTable
    assert(type(nativeSpawn) == 'function', 'Native entity spawn API missing')
    HistoryLegacySpawnCompat = { native = nativeSpawn, callbackCalls = 0 }
    function SpawnEntityFromTable(classname, values, context, callback, extra)
        if callback ~= nil then
            assert(type(callback) == 'function' and extra == nil,
                'Unsupported legacy entity spawn callback form')
        end
        local entity = nativeSpawn(classname, values)
        if callback ~= nil then
            assert(entity ~= nil, 'Native entity spawn did not return an entity')
            HistoryLegacySpawnCompat.callbackCalls = HistoryLegacySpawnCompat.callbackCalls + 1
            callback(context, entity)
        end
        return entity
    end
    print('HISTORY_LEGACY_SPAWN_COMPAT_READY')
end

# 7.22 Lua 技能验证模块

这是独立作者源，已于 2026-10-06 在 7.22 / build 3504 的普通本地比赛（酒仙）与原生英雄试玩（发条技师）验证加载、添加、1→2 升级、真实施放和删除 `sven_storm_bolt`。技能图标可见，施放有耗蓝、眩晕、掉血和冷却，删除后原技能、天赋及隐藏项保持一致。测试会话及临时挂载已清理，尚未加入档案馆 0.3.5。没有编辑面板，不承诺任意技能、复杂依赖或其他构建兼容。完整证据见 [运行验证](../../docs/legacy-ability-sandbox.md)。

模块不调用 `Activate`，不覆盖 Valve 入口、脚本或 VPK，不修改 DLL，不执行用户输入的 Lua。采用仓库的 PolyForm Noncommercial 1.0.0 许可。

## 接口与条件

- 返回模块表；重复加载返回同一实例，命令不重复注册。
- 只允许 server Lua、非专服、本地 listen host、`sv_cheats 1`。命令由其他玩家发起时拒绝执行。
- 默认只允许已经初始化的原版 `hero_demo`。普通 `dota` 地图须由测试者显式调用 `EnableOrdinaryTest(true)`；该设置仅存在于当前 Lua VM。
- `Environment()`：只报告地图、Lua 环境和 API 类型；不输出玩家身份，也不自动授权普通地图。
- `Status()` / `List()`：输出本机英雄、每个槽位、等级、隐藏/启用状态及模块新增状态。
- `Precache("npc_dota_hero_sven")`：独立请求异步预载；等待 `CHRONICLE_ABILITY_PRECACHE_READY` 后才允许添加。
- `Add("sven_storm_bolt")`：拒绝已有同名技能和没有已核实空槽的英雄；不覆盖、不重排原技能。添加后核对原技能索引、等级、隐藏和启用状态，异常时只尝试删除新增技能，分别报告清理结果及原状态是否保持。
- `Level("sven_storm_bolt", 1)`：只修改模块自己添加的同一技能句柄，等级限定在本机原生 `GetMaxLevel()` 范围内，并且最大不超过 4。
- `Remove("sven_storm_bolt")`：只删除模块自己添加、仍属于当前本机英雄的同一技能句柄。不会删除原生技能或清理其他 modifier。
- `TestCast()`：仅对已成功添加、等级至少为 1、已启用且不在冷却的风暴之拳下达真实引擎施法命令。按需异步预载敌方近战兵，然后创建唯一的模块目标；设置目标基础回复为零、定身和缴械，不修改原敌军。记录英雄原位置和朝向后，将英雄及目标放在隔离区域内，相距约 300。
- `TestResult()`：读回施法前后的魔法值、目标生命、眩晕和技能冷却。施法命令发出后也会尝试在约 0.7 秒和 1.0 秒自动读回；实际调度受引擎帧和游戏暂停影响。
- `ClearTarget()`：撤销尚在预载中的自动施法意图，只销毁模块创建的目标。清理自己的目标不要求作弊和试玩上下文仍启用；命令仍限本机 host。只有同一本机玩家、同一英雄实例、同一地图才请求恢复原位置和朝向。目标另有约 10 秒的超时清理；读回时上下文失效也会清理自己的目标。不会操作其他敌军或更换后的英雄。先清理目标再关闭普通地图测试授权。
- `RegisterCommands()`：注册下面的 `FCVAR_CHEAT` 命令。模块首次加载也会输出环境并尝试注册。

```text
chronicle_ability_env
chronicle_ability_test ordinary
chronicle_ability_precache
chronicle_ability_list
chronicle_ability_add sven_storm_bolt
chronicle_ability_level sven_storm_bolt 1
chronicle_ability_cast
chronicle_ability_cast_result
chronicle_ability_target_clear
chronicle_ability_remove sven_storm_bolt
```

## 已验证的手动加载方式

将本目录的 `chronicle_ability_probe_v1.lua` 复制到对应 7.22 客户端的 `game/dota/scripts/vscripts/`；若已经有同名文件，先核对而非覆盖。正常启动主菜单，在英雄详情页选择没有风暴之拳的英雄，点击“试玩英雄”。原生试玩无需 `-dev`。通过 F8 打开控制台，按以下入口加载：

```text
sv_cheats 1
script_reload_code chronicle_ability_probe_v1.lua
chronicle_ability_env
chronicle_ability_precache
```

普通 `dota` 地图在加载后、预载前另执行 `chronicle_ability_test ordinary`；本轮普通成功对照使用了 `-dev`，未单独验证不带它的普通技能链。原生 `hero_demo` 不需要普通地图授权。模块加载本身不创建模式或调用 `Activate`。本构建的通用内联 `script` 在原参数与 `-dev` 下均为未知命令，`script_reload_code 文件名.lua` 已实际执行成功。

等待 `CHRONICLE_ABILITY_PRECACHE_READY` 后，依次执行 list、add、level、cast、cast_result、target_clear、remove、list。`add` 新增的技能初始等级为 0，必须随后 `level` 到 1 或以上；可以用 `level ... 2` 验证升级。也可点击 HUD 技能对敌人施放，但本轮施放验收使用服务端的真实 `CastAbilityOnTarget` 指令，未单独验收键盘施法。自动施放会暂时移动英雄并创建自有目标，测试后显式执行 target_clear；不把该验证动作作为成品交互。目标预载完成后会再次检查上下文再执行请求，上下文改变则取消。

退出游戏后，可删除自己复制且未修改的同名模块文件；不会改动 Valve 原入口。不要在运行中的游戏更换模块文件，已加载的 VM 会缓存旧实例。三轮验证的原文件与启动租约恢复全部通过。

记录图标、施放、魔法值、伤害及删除后的状态。`CHRONICLE_ABILITY_ADDED` 仅证明原生调用和读回成功；`CHRONICLE_ABILITY_CAST_ORDER` 仅表示引擎调用未报错。`CHRONICLE_ABILITY_CAST_RESULT` 给出证据，不自动宣称玩法测试通过。图标可能处于隐藏槽；模块只报告 `VISIBILITY_UNCONFIRMED`，不会交换或启用原生技能，也不会直接调用 `OnSpellStart` 冒充实际施法。

不要用 `script_reload` 重启整个试玩入口。本模块在全局保存实例，重复执行文件或清掉 `package.loaded` 后仍会重用实例；已经加载旧工具的 VM 不会因此升级。退出本轮地图并重新建立 Lua VM，是重置工具和加载新版源码的边界。

原生移除技能不保证清除其在场上的所有投射物、召唤物或持续效果。先等风暴之拳施放完成再删除；本轮不扩大到复杂技能，也不测试跨机多人。

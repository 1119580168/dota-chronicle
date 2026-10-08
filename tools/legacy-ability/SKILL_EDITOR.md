# 原生英雄试玩技能编辑器作者源

此模块面向 **7.22 / build 3504** 的本机单人原生 `hero_demo_*`，与前期只允许斯温风暴之拳的最小 probe 分开。目录来自运行客户端的 `LoadKeyValues`；仓库只含原创 Lua、界面作者源与编译后的原创面板，不包含 Valve KV、地图或复制的原生样式。模块没有普通比赛授权入口，不调用 `Activate`，不改原生面板清单。

状态：**0.3.6 已部署，打包程序自动加载、原生命令增删升级与五文件恢复通过**。不朽尸王中已显示动态面板，GUI 搜索、添加、升级与移除风暴之拳均成功，时间锁取得被动效果读回；昆卡退出后再次进入试玩自动加载通过。马格纳斯新 Lua VM 与打包会话分别验证目录 API 和原生控制台中英文检索，中文 GUI 输入未单独实测。这些结果只涵盖当期构建和已测操作，不等于任意复杂技能都能跨英雄运行。档案馆入口见 [README](../../README.md)，完整证据见 [运行验证记录](../../docs/legacy-ability-sandbox.md)。

## 加载与命令

日常使用在档案馆 7.22 详情选择「技能编辑器」，先进入主菜单，再选择任意英雄进入原生英雄试玩。启动器确认本程序拥有的游戏与控制监听、原生试玩地图、本机 loopback、1 名真人与 0 个机器人后自动加载。此流程不需要 `-dev`，沿用语言设置与 F8 备用控制台绑定，不开普通比赛或完整 addon。

退出试玩后，检测到空地图状态会回到 waiting-demo；再进入合法试玩重新加载。昆卡退出后进入同英雄试玩已实测重新达到 ready。主动关闭当前地图内面板不会被立即打开；若一次快速退出和同地图重进都发生在两次轮询之间，现有状态字段可能不能识别新的 Lua VM，不保证该路径自动重载。

运行时安装与退出清理由启动器管理，同构建编译步骤见 [原创面板加载记录](../../docs/legacy-skill-editor-ui-loading.md)。以下是已初始化本机试玩中的等效固定加载命令，不应拿它们绕过启动器的构建和归属检查：

```text
sv_cheats 1
script_reload_code chronicle_skill_editor_v1.lua
chronicle_skill_panel
```

模块加载输出 `CHRONICLE_SKILL_EDITOR_LOADED`；动态面板请求输出 `CHRONICLE_SKILL_EDITOR_PANEL requested`。后者只表示服务端已请求创建。首次合法本机面板状态请求会产生 `CHRONICLE_SKILL_EDITOR_UI_READY`；后台须同时等到加载和 UI 往返确认后才报告就绪，实际画面仍需检查。

面板关闭后可按 F8 并输入 `chronicle_skill_panel open` 重新打开；无参数命令切换开关。关闭面板保留当前试玩中本工具新增的技能。

```text
chronicle_skill_panel [open|close]
chronicle_skill_snapshot
chronicle_skill_catalog [query] [category] [page]
chronicle_skill_add <native_ability_name> [level] [risk]
chronicle_skill_level <native_ability_name> <level>
chronicle_skill_remove <native_ability_name>
```

`chronicle_skill_status` 和 `chronicle_skill_search` 分别是查询别名。`risk` 是高级项的明确确认。技能等级允许 `0..GetMaxLevel()`，零表示取消该新增技能的等级；原技能和天赋始终只读。分类为 `default`、`all`、`hidden`、`talent`、`item`、`generic`、`complex`；默认分页 18 项，最多 24 项。

已有同名技能、满槽、越界或非整数等级会被拒绝。服务记录自己添加的准确原生句柄，删除时核对当前英雄与同名句柄；被其他系统替换的同名技能不再属于本工具。新增失败的残留实例仅允许删除。升级与删除后检查其他技能的槽位、等级、隐藏和启用状态；原生引擎若改变其他技能，结果标为失败，不声称已恢复，也不重写原技能。

添加时按本机 KV 查找来源英雄并异步预载。关闭面板、超时或切换英雄后，迟到的预载回调不会继续添加。缺少来源英雄的定义需要高级确认，只能尝试原生添加，无法保证资源预载。关联技能仅展示为提示，不自动递归添加；复杂技能、天赋、物品技能和隐藏项的效果未普遍验证。删除不笼统清除持续效果、召唤物或 modifier。

重复加载保留同一模块对象和新增实例归属记录。记录不跨 Lua VM、地图或新的英雄实例持久化；不提供保存技能方案、替换、换序或清空原技能功能。修改作者源后的完整验证需新的 Lua VM，不能删除全局记录来模拟更新。

发行 manifest 保持 4 个原创文件。后台读取本机 loose / VPK 的 `npc_abilities.txt` 与 `items.txt`，按真实定义 ID 精确筛选四个固定 UTF-16 本地化文件的名称，另生成 `game/dota/scripts/npc/chronicle_skill_localization_v1.txt`，不采集描述或参数文案，不发行 Valve 名称文本。固定文件为 `abilities_english.txt`、`abilities_schinese.txt`、`items_english.txt`、`items_schinese.txt`，均在原 `resource/localization/` 下。旧 Lua 直接读取它们会返回 nil 并产生解析日志，现改读这个临时 UTF-8 索引，已实机确认。

运行租约管理 4 个原创文件加 1 个本机派生索引，派生文件同样检查指纹、独占创建并精确恢复。进程结束后守护执行恢复；遇到外部更改保留并报告。关闭面板与恢复客户端文件是不同阶段，不提前删除仍在运行进程使用的资源。

游戏仍在运行时禁止重编译并覆盖正在租用的 payload；先结束 owned 会话并完成恢复，再重建资源和启动新会话。运行中热替换会改变租约指纹，恢复应保留该外部更改，而不是删除它。

## 动态面板协议

动态 HUD 只管理 `chronicle_ability_editor`，使用 `file://{resources}/layout/custom_game/chronicle_ability_editor.xml`。原创界面源位于相邻 `ui` 目录，同构建 Resourcecompiler 已编译并实际加载 `.vxml_c`、`.vjs_c`、`.vcss_c`。布局根 Panel 不设 `id`，只引用客户端原有 `dotastyles` 依赖，不复制 Valve 文件。

客户端发送 `chronicle_ability_ui_request`，仅允许 `snapshot`、`catalog`、`add`、`level`、`remove`、`close`。负载包含 `requestId` 和相应的 `ability`、`level`、`query`、`category`、`page`、`pageSize`、`allowRisk`。`allowRisk` 只接受显式 `true`、`1`、`"1"`、`"true"`。

服务严格用引擎事件 `source` 经 `EntIndexToHScript` 获取实体，要求其等于 `GetListenServerHost()`；负载的 `PlayerID` 不参与授权。真实 7.22 来源参数是 number，GUI 操作已通过该实体相等检查，未用负载身份兜底。操作还要求非专服、服务端 Lua、`sv_cheats`、原生试玩标记、试玩地图、单人以及本机真实英雄所有权。

服务只向真实本机玩家发送 `chronicle_ability_ui_state`，含 `requestId`、`ok`、`error`、`revision`、当前英雄、技能槽快照、目录分页和可选预载状态。技能记录中的 `owned/readonly` 以当前句柄读回为准。异步完成沿用原 `requestId`，不凭请求已发出或面板按钮点击就宣称成功。

## 实机验证范围

| 项目                 | 已观察结果                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 目录                 | 本轮 7.22 读取 1923 项全部定义、668 项默认目录；这不是效果兼容名单                                                                                                                                                       |
| 搜索                 | GUI 输入 `sv` 后筛出斯温 4 个技能                                                                                                                                                                                        |
| 增删与等级           | GUI 添加 `sven_storm_bolt` 等级 1，升至 2，再移除成功；新增与移除图标同步                                                                                                                                                |
| 原技能               | 14 个原技能、隐藏项和天赋槽保持名称、索引、等级、隐藏及启用状态；原天赋等级为 0                                                                                                                                          |
| 原生施法             | 私有 `CastAbilityOnTarget` 实测约 0.7 秒耗蓝 119（成本 120，回蓝影响读回）、眩晕 true、冷却 14.7100 秒；不据此证明纯技能伤害或声音                                                                                       |
| 时间锁被动           | `faceless_void_time_lock` 等级 4 在不朽尸王上存在，原生 `modifier_faceless_void_time_lock` 已生效；30 次原生攻击的分次样本均读到目标眩晕，持续眩晕覆盖采样，不等于 30 次独立触发                                         |
| 权限与往返           | 数值 source 解析为真实本机 host，首次面板状态请求产生 UI_READY                                                                                                                                                           |
| 自动化回归           | 后台 130 项中 129 通过、1 项 Windows 文件 symlink 权限跳过；目录 junction 通过。Lua 834 次 mock 断言与 5.1 语法检查、Panorama 与 Electron 技能入口测试通过                                                               |
| 首轮会话恢复         | owned 游戏与 worker 已退出，原文件、路由、CFG、绑定、媒体与临时资源最终审计通过；开发热替换处理见运行记录                                                                                                                |
| 冷启动与重新进入试玩 | 新会话正常 ready、无 error；昆卡退出试玩到 waiting-demo 后再次进入达到 ready。该轮 10 个原文件、路由、CFG、绑定、媒体、4 个工具文件与私有诊断恢复通过                                                                    |
| 名称索引与目录 API   | 马格纳斯新原生 Lua VM ready / UI_READY、无 error；索引 1588 个名称、186299 B。私有只读 `M.Search` 查询「风暴」20 项、「Storm Hammer」4 项（主技能及 3 个斯温天赋）、精确内部名 1 项，均含目标技能；不是中文 GUI 输入实测 |
| 五文件恢复           | 5 个租约文件和 1 个私有验证文件已清除，10 个原文件、Steam 双路由、CFG、版本绑定与媒体逐字节不变，owned 游戏与 worker 均退出                                                                                              |
| 最终发行             | 0.3.6 已部署、0.3.5 完整备份保留；实际打包 worker 在马格纳斯新试玩自动 ready / UI_READY，无 error，原生命令添加 1→等级 2→删除成功，无 runtime error，正常停止后 5 个工具文件清除及原字节恢复通过                         |

打包会话另用原生控制台带引号查询「风暴」，all 分类第 2 页包含斯温、共 20 项；英文「Storm Hammer」共 4 项。它证明部署后的原生命令与目录可用，不等于中文 GUI 输入实测。本轮没有私有验证模块，正常退出后游戏与 worker 退出，10 个原文件、Steam 双路由、CFG、版本绑定与媒体配置恢复通过。

日常部署 UI 独立检查无页面错误或外部请求，7.22 技能按钮可用，原封面与完整媒体库指纹保持；这轮 UI 检查没有启动游戏。发行隔离技能 UI、34 个关键打包文件与 4 个原创 payload 匹配通过，完整归档记录见 [验证文档](../../docs/validation.md)。中文 GUI 输入、声音、复杂依赖和多人仍须单独验收。

## 静态与模拟验证

从仓库根目录运行：

```text
npm exec --yes --package=luaparse@0.3.1 -- luaparse --quiet tools/legacy-ability/chronicle_skill_editor_v1.lua tools/legacy-ability/tests/skill-editor-mock.lua
npm exec --yes --package=fengari-node-cli@0.1.0 -- fengari tools/legacy-ability/tests/skill-editor-mock.lua
```

模拟测试只使用原创虚构 KV 和引擎模型，检查原技能保护、准确实例归属、异步取消、请求来源、分类/分页、错误等级及独立 HUD 生命周期。它不验证引擎资源、技能实际效果、界面编译或多人连接。

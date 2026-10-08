# 7.22 技能编辑器：原创 Panorama 面板加载路径

检查日期：2026-10-06。范围：7.22 / build 3504 当期编译器、原生试玩资源与原创面板。**0.3.6 已部署，打包程序自动加载和五文件恢复通过**；同构建编译、Dynamic HUD、冷启动、再次进入试玩与本机名称索引均已实测。不朽尸王中完成 GUI 增删与升级，时间锁被动另有原生效果读回，马格纳斯新 Lua VM 验证名称索引及目录检索。中文 GUI 输入未单独实测。档案馆入口见 [README](../README.md)，技能范围见 [模块说明](../tools/legacy-ability/SKILL_EDITOR.md)。

## 结论与最小路线

本机 7.22 包内已有当期 `resourcecompiler.exe` 和 `resourcecompiler.dll`，不必先借用最新版工具。原生教程使用 `CustomUI:DynamicHud_Create` / `DynamicHud_Destroy`，原生 `hero_demo` 的面板资源格式也能直接核对。

现有实现将原创 XML / JS / CSS 暂存为 `.vxml` / `.vjs` / `.vcss`，用同构建编译器生成独立命名的 `.vxml_c` / `.vjs_c` / `.vcss_c`。服务端唯一模块在已初始化的原生英雄试玩中动态创建面板，保持原 `custom_ui_manifest.vxml_c`、`hud_hero_demo` 和 Valve Lua 入口不变，不需要完整 addon 或重新编译地图。

动态面板创建是请求，服务端未抛错不能证明客户端解析、显示和事件往返成功。后台须等到 `LOADED` 和首次合法本机面板状态请求产生的 `UI_READY`，再报告就绪。本轮同时取得实际面板画面和真实 GUI 操作回包；不能只用 `PANEL requested` 代替这些证据。

## 当期编译器与依赖

以下路径相对于用户已有的 7.22 客户端根目录：

| 文件                                  |         大小 | SHA-256                                                            |
| ------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `game/bin/win64/resourcecompiler.exe` |    137,504 B | `b8ab1d1a410b70845d69ef5776913d5016248359fbf80a3bb23b92989dbafbdd` |
| `game/bin/win64/resourcecompiler.dll` | 10,973,984 B | `29ee37c3511a3526fa3f3df96bbef5e8cc388fff9b04d9676f0c16e68d61f049` |

DLL 有 `PanoramaCompiler`、`CompilePanorama`、Layout / Script / Style Compiler Version 标识，内含构建日期 **May 7 2019**。文件没有可读的 Windows FileVersion / ProductVersion；版本认定依据其所在已核实构建与文件指纹。

PE 导入表的基础依赖均能在同一 `win64` 或 Windows 系统目录找到：`steam_api64.dll`、`tier0.dll`、`vstdlib.dll`、`libfbxsdk.dll` 及系统 DLL。`panorama.dll` 依赖的 `SDL2.dll`、`v8.dll`、`video64.dll` 也在同目录。导入表检查用于定位依赖；本轮编译器可运行的结论来自三类原创资源的实际编译成功。

编译器内有 `Failed to load expected panorama config file` 的错误分支。本包不是缺少该配置：`game/core/pak01_dir.vpk` 的 archive 0 包含 222 B 的 `panorama/panorama_config.txt`，其中 `resources` 指向 `panorama`，另有 `config`、`images`、`localization` 的命名路径。它在 VPK 内，不是 loose 文件；正常挂载 `core` 时应由文件系统读取，先不要抽取覆盖。

7.22 根目录只有 `game` 与 `_CommonRedist`，未提供原始 `content` 树。同机检查的 6.85b、6.88c、7.00、7.19、7.23e 包均有各自的 `resourcecompiler.dll`，但对应 `win64/resourcecompiler.exe` 不在检查位置。这些不是当前首选，也不能直接与 7.22 EXE 混用后宣称兼容。

## 原生试玩的 UI 格式

`game/dota_addons/hero_demo/panorama` 有六个文件：

- `layout/custom_game/custom_loading_screen.vxml_c`
- `layout/custom_game/custom_ui_manifest.vxml_c`
- `layout/custom_game/hud_hero_demo.vxml_c`
- `scripts/hud_hero_demo.vjs_c`
- `styles/hud_hero_demo.vcss_c`
- `images/control_icons/double_arrow_left_png.vtex_c`

前三类 UI 核对得到 resource header version **12**、resource version **3**。这是实际当期资源，不应笼统写成新版 `.xml_c` / `.js_c` / `.css_c`。

原 manifest 的 DATA 块引用：

```xml
<CustomUIElement type="Hud" layoutfile="file://{resources}/layout/custom_game/hud_hero_demo.xml" />
```

实际 HUD 的依赖引用采用已编译路径：

```xml
<include src="s2r://panorama/styles/dotastyles.vcss_c" />
<include src="s2r://panorama/styles/hud_hero_demo.vcss_c" />
<include src="s2r://panorama/scripts/hud_hero_demo.vjs_c" />
```

它使用 `Panel`、`Button`、`ToggleButton`、`Label`、`DOTAUIHeroPicker` 及当期 Panorama CSS。JS 有 `$.RegisterEventHandler`、`$.DispatchEvent` 和普通函数 / IIFE。新面板先使用保守 ES5 语法与当期控件，不引入浏览器 DOM、React 或现代 CSS。

`client.dll` 还包含 `GameEvents`、`SendCustomGameEventToServer`、`Subscribe`、`Unsubscribe`、`DOTAAbilityImage`、`TextEntry`、`GetLocalPlayerID`、`SetPanelEvent` 的精确名称。静态名称不是运行证明；本轮图形实测已进一步确认面板事件、状态回包、搜索控件及新增技能图标。

## 已验证编译命令与隔离输出

用 `$Client` 表示用户已有 7.22 客户端，用 `$Build` 表示独立构建目录。先在构建目录准备对应的 `content/dota/panorama` 树；不要把原创 source 写进原 addon，也不要让生成物覆盖原资源。

作者源保持常见 `.xml` / `.js` / `.css` 后缀，构建脚本将它们复制到私有 staging 的 `.vxml` / `.vjs` / `.vcss` 路径。**本版直接把 `.xml` 作为编译输入会报 `Unknown resource type`**；正确输入须使用当期资源类型后缀。以下布局命令已实际成功：

```powershell
& "$Client/game/bin/win64/resourcecompiler.exe" `
  -nop4 -f `
  -game "$Client/game/dota" `
  -contentroot "$Build/content" `
  -outroot "$Build/game" `
  -i "$Build/content/dota/panorama/layout/custom_game/chronicle_ability_editor.vxml"
```

JS 和 CSS 使用相同参数，分别传入 `content/dota/panorama/scripts/custom_game/chronicle_ability_editor.vjs` 与 `content/dota/panorama/styles/custom_game/chronicle_ability_editor.vcss`。实际构建先 JS、CSS，最后 layout；不依赖 XML 自动编译所有资源。输出目录是 `$Build/game/dota/panorama/...`，`-outroot` 不再追加 `/dota`。

实际构建入口为 [build-skill-editor.cjs](../scripts/build-skill-editor.cjs)：

```powershell
node scripts/build-skill-editor.cjs "$Client"
```

脚本检查 `ClientVersion=3504`，只将原创源暂存到忽略的 `local/skill-editor-build`，用客户端 `game/dota` 提供原生依赖，输出到独立私有构建树。它不改原 `gameinfo.gi`，也不把构建输出直接写进真实客户端。

已核实的参数注意事项：

- 所有 options 放在输入文件开始之前；此版遇到输入后追加 options 会明确报错。
- `-nop4` 禁止自动 Perforce checkout / add。
- 批处理不要加 `-pause` 或 `-pauseiferror`，避免错误后阻塞等待键盘。
- `-r` 只在明确的原创资源通配范围使用，不递归编译整个客户端。
- `-novpk` 的帮助用于地图及其子资源输出；普通面板不需要打包地图或重写 VPK。

三个原创 `_c` 的 resource header version **12**、resource version **3** 均与当期原生资源一致。脚本连同原创 Lua 输出 `resources/skill-editor/7.22/manifest.json`，记录 `schema: 1`、`clientBuild: 3504` 和四个固定 source / target / SHA-256。后台校验原创清单与文件指纹，只接受这四个精确目标；不扫描或覆盖原生同名 UI。运行时名称索引另从用户本机资源派生，不加入这份发行 manifest。

首轮布局编译后曾因最外层 Panel 设置 `id` 导致动态加载错误，去掉该根 Panel 的 `id` 后显示成功。子 Panel 可保留用于查找和事件处理的 `id`。`dotastyles.vcss_c` 作为本机原生依赖引用，不复制到项目或发行包。

## 无 manifest patch 的动态 HUD

`server.dll` 存在 `DynamicHud_Create`、`DynamicHud_Destroy`、`DynamicHud_SetVisible`、`DynamicHud_SetDialogVariables`。原包 `tutorial_assist_game/scripts/vscripts/addon_game_mode.lua` 的 12–15 行说明接口，多处实际调用；1562 行创建 details 面板，1886 行创建 tutorial client code。`tutorial_basics` 也实际使用同一接口。

原创模块可用以下结构，玩家 ID 必须从真实本机 host 解析：

```lua
CustomUI:DynamicHud_Create(
    hostPlayerID,
    "chronicle_ability_editor",
    "file://{resources}/layout/custom_game/chronicle_ability_editor.xml",
    {}
)

CustomUI:DynamicHud_Destroy(hostPlayerID, "chronicle_ability_editor")
```

原创布局引用本机样式和唯一原创资源，引擎解析 file alias 对应的当期 compiled 文件：

```xml
<include src="s2r://panorama/styles/dotastyles.vcss_c" />
<include src="file://{resources}/styles/custom_game/chronicle_ability_editor.css" />
<include src="file://{resources}/scripts/custom_game/chronicle_ability_editor.js" />
```

已验证的四个原创工具文件安装路径如下，相对于已绑定的客户端根目录：

- `game/dota/panorama/layout/custom_game/chronicle_ability_editor.vxml_c`
- `game/dota/panorama/scripts/custom_game/chronicle_ability_editor.vjs_c`
- `game/dota/panorama/styles/custom_game/chronicle_ability_editor.vcss_c`
- `game/dota/scripts/vscripts/chronicle_skill_editor_v1.lua`

普通 `dota`、`core` 与当前原生 addon 的搜索路径由原 `gameinfo.gi` 挂载。本轮原生 `hero_demo` 已实际读到这些新资源，无须另加 overlay 或 patch 原 manifest。安装与恢复由精确文件租约管理，正常关闭 owned 游戏后再清理；外部更改保留并报告。

名称索引增加第五个临时路径 `game/dota/scripts/npc/chronicle_skill_localization_v1.txt`。准备阶段读取本机 loose / VPK 的 `npc_abilities.txt`、`items.txt`，按真实定义 ID 筛选 `resource/localization/` 下的 `abilities_english.txt`、`abilities_schinese.txt`、`items_english.txt`、`items_schinese.txt`，只提取名称并转为 UTF-8，不提取描述和参数文案。当期 Lua 直接加载原 UTF-16 文件返回 nil，并产生大量解析日志。该索引不含于公开仓库或发行包，按精确 hash、独占创建和外部改动保留规则加入运行租约。实机索引为 1588 个名称、186299 B，目录 API 中英文检索和五文件退出恢复均通过；中文 GUI 输入仍未单独验收。

生产流程禁止在游戏运行中重编译并覆盖已租用资源。首轮开发热编译布局导致指纹变化，恢复链正确保留外部改动；测试者按精确编译字节核对后完成恢复审计。正常重建流程应先结束会话和恢复，再编译、重新启动。

面板请求只发送有限动作和技能名称。服务端独立验证事件来源实体确实是本机 host、原生试玩上下文、单人状态、真实当前英雄、运行时 KV 目录与精确新增句柄。实机引擎 source 为 number，`EntIndexToHScript(source)` 等于真实 host；不能接受前端传来的 PlayerID 作为授权依据，也没有任意 Lua 文本入口。

首次合法 snapshot 请求产生 `UI_READY`，关闭再打开会重置此确认。UI 生命周期不会擅自移除工具已添加的技能；技能记录不跨新地图 Lua VM 或新的英雄实例持久化。已测连续路径为退出昆卡试玩到 waiting-demo，再次进入同英雄自动加载并 ready；不保证两次轮询之间完成的快速同地图重进可被识别。进程守护、停止归属和文件租约恢复另属会话生命周期。

## 未编译资源与官方文档的证据范围

当期 Panorama DLL 有 XML / CSS 解析与文件加载逻辑，不能据此认定任意 raw `.xml` / `.js` / `.css` 在普通或试玩运行中都受支持。原包实际使用 compiled 资源，本轮未找到能证明 raw 运行路径的当期设置或成功样例，因此 raw 文件不是目前已验证的备用方案。

已按要求查询 Valve 官方技术页面：[Panorama](https://developer.valvesoftware.com/wiki/Dota_2_Workshop_Tools/Panorama)、[Custom UI Manifest](https://developer.valvesoftware.com/wiki/Dota_2_Workshop_Tools/Panorama/Custom_UI_Manifest)、[Resourcecompiler](https://developer.valvesoftware.com/wiki/Resourcecompiler)。本次正文请求均返回 403 / inaccessible，不能用未读到的网页内容证明 2019 兼容性。[Valve 的 Panorama Debugger 页面检索摘要](https://developer.valvesoftware.com/wiki/Zh/Dota_2_Workshop_Tools/Panorama/Debugger)提供了调试入口背景，但不证明本包所需的编译或动态 HUD 行为。关键判断以本机构建的 DLL、原脚本和编译资源为依据。

当前编译、动态显示、合法状态往返及 GUI 搜索 / 添加 / 升级 / 移除已完成实机验证。目录读回 1923 项全部定义、668 项默认目录，GUI 搜索 `sv` 筛出斯温 4 项；这些数量不表示所有技能效果兼容。私有只读 `M.Search` 查「风暴」返回 20 项、查「Storm Hammer」返回主技能及 3 个斯温天赋共 4 项、精确内部名 1 项，包含正确中文显示的风暴之拳；该证据不等于中文 GUI 输入实测。

冷启动和退出后再次进入试玩均达到 ready；新名称索引会话在马格纳斯新原生 Lua VM 达到 ready / UI_READY，无 error。5 个租约文件与 1 个私有验证文件清除，10 个原文件、Steam 双路由、CFG、版本绑定与媒体逐字节不变，owned 游戏与 worker 已退出。后台 130 项中 129 通过、1 项 Windows 文件 symlink 权限跳过；junction、Lua 834 次 mock 断言及 5.1 语法检查、Panorama 与 Electron 技能入口测试通过。

0.3.6 发行部署已完成，保留原 0.3.5 完整备份。部署程序创建的实际 worker 在马格纳斯新原生试玩中自动 ready / UI_READY，无 error；原生控制台「风暴」带引号查询共 20 项、all 第 2 页包含斯温，英文「Storm Hammer」共 4 项。原生命令添加风暴之拳等级 1、升至 2、删除均成功，日志无 runtime error。这证明打包入口与命令路径，不是中文 GUI 输入验收。

本轮没有私有验证模块。owned 游戏与 worker 均退出，5 个实际工具文件清除，10 个原文件、Steam 双路由、CFG、版本绑定和媒体配置恢复通过。独立日常 UI 轮没有启动游戏，7.22 技能按钮可用，页面错误和外部请求为 0，封面与完整媒体库指纹保持。34 个关键打包文件和 4 个原创 payload 与作者源 / 清单匹配，发行隔离技能 UI 测试通过；完整归档检查见 [验证记录](validation.md)。中文 GUI 输入、复杂技能、资源音效与多人需独立验收。

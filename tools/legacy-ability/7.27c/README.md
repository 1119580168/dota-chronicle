# 7.27c 阿哈利姆迷宫技能编辑器

本目录是迷宫专用的 Lua 与 Panorama 作者源。7.22 英雄试玩编辑器仍使用上级目录中的独立文件。

运行范围为 7.27c / build 4397 的官方 `aghanim` 插件、`main` 地图。服务端还要求已初始化的 `GameRules.Aghanim`、本机监听服务器、`sv_cheats`、单人房间以及玩家实际拥有的非克隆英雄。编译资源与客户端构建由启动器分别核对；本目录不携带游戏资源。

选人后可以搜索本机版本的原生技能、添加技能、调整新增技能的等级、删除本工具添加的当前实例。迷宫原技能、技能碎片、地图脚本与原 UI 保持原有归属。收起或关闭面板保留已添加技能；关闭同时取消尚未完成的资源预载。

技能目录读取运行客户端的 KV，并检查迷宫覆盖定义；被 Lua 或 datadriven 脚本覆盖的名字以及仅存在于迷宫中的自定义技能不纳入原生目录。复杂技能、天赋、隐藏项和物品技能需要额外确认，添加成功仍不代表跨英雄效果、声音、粒子或迷宫碎片兼容。新增普通技能不会自动获得迷宫原技能的传奇碎片效果。

控制台示例：

```text
chronicle_labyrinth_skill_context
chronicle_labyrinth_skill_panel open
chronicle_labyrinth_skill_search crystalmaiden_crystal_nova
chronicle_labyrinth_skill_add crystalmaiden_crystal_nova 1
chronicle_labyrinth_skill_level crystalmaiden_crystal_nova 2
chronicle_labyrinth_skill_remove crystalmaiden_crystal_nova
chronicle_labyrinth_skill_panel close
```

`context` 是固定只读的加载器握手：正确地图中的玩家尚未选人时输出 `CHRONICLE_LABYRINTH_SKILL_CONTEXT_WAIT`；真实归属英雄就绪后输出 `CHRONICLE_LABYRINTH_SKILL_CONTEXT_READY`。它不打开面板、不添加技能，便于文件加载器在选人后再请求动态面板。

添加先预载来源英雄的资源，需等待完成后再升级或删除。图形面板使用相同服务端接口，只接受引擎认证的本机玩家事件，不接受任意代码。服务端拥有新增技能的准确句柄，同名替换实例也不能当作原来的新增技能删除。

源代码验证：

```powershell
npm exec --yes --package=luaparse@0.3.1 -- luaparse --quiet tools/legacy-ability/7.27c/chronicle_labyrinth_skill_editor_v1.lua tools/legacy-ability/7.27c/tests/skill-editor-mock.lua
npm exec --yes --package=fengari-node-cli@0.1.0 -- fengari tools/legacy-ability/7.27c/tests/skill-editor-mock.lua
node tools/legacy-ability/7.27c/tests/panorama-ui.cjs
```

mock 覆盖了本机权限、地图/插件约束、控制器解析、事件来源、原技能与迷宫技能保留、精确实例归属、预载超时/英雄切换/关闭取消和覆盖定义排除。通过这些检查不等于游戏内画面、实际施放、完整通关或跨机多人已经验证；原生验收结果另见项目验证记录。

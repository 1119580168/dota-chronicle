# Dota Chronicle

独立、完全离线的 Windows 桌面启动器。禁止加入云认证、遥测、自动更新或运行时 CDN。游戏客户端与 Steam 的依赖单独说明。

- `src` 是作者源；`src/ui/assets`、`src/ui/styles.css`、`release` 是生成物。
- 游戏文件、用户绝对路径、身份、密码、原生日志和 AppData 状态不得提交。
- 只管理本程序创建的进程；停止与恢复必须验证 PID、可执行路径和创建时间。
- Steam 注册表路由与 Source 1 活动挂载是可恢复的生命周期租约；关闭界面不能提前恢复正在使用的租约。
- 活动基础试玩通过不等于完整通关，也不等于跨机多人通过。
- 采用未修改的 PolyForm Noncommercial 1.0.0。第三方依赖保留原许可；不包含 Valve 游戏资源。

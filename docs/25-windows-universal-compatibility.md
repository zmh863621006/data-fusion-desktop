# Windows 通用安装包（1.0.21 内部测试）

## 交付范围

用户只需运行 `数据融合助手-兼容通用安装包-1.0.21-x64.exe`。外层 NSIS 安装器按操作系统选择内部组件，不要求用户选择 Win7/Win10 版本。2026-11-11 用户确认单独的 Win7 安装修复包安装正常，本次将该修复合入通用包。

| 环境 | 运行环境 | 配置目录 |
| --- | --- | --- |
| Windows 7 7600 / SP1 x64 | Electron 22.3.27、Chromium 108、Node 16.17.1 | `%APPDATA%\data-fusion-desktop-win7` |
| Windows 10/11 x64 | Electron 44.3.0 | `%APPDATA%\data-fusion-desktop` |

32 位 Windows 和 Win8/8.1 不在本次支持范围，安装器拒绝继续。Win7 7600 不再被 SP1 检查拦截。默认通用包不包含、下载或安装 SP1、.NET4 或其他系统更新，不写入 RunOnce，也不重启系统。

本次只生成本地测试包，不上传发布后台、不推送自动更新、不替换本机正式应用。Win7 兼容组件暂时禁用在线更新，避免收到现有只适用于现代 Windows 的安装包。正式发布通用版前需要另行接通统一发布和更新流程。

## 兼容实现

- Win7 入口先补充 Node16 缺失的 Web API，再初始化业务代码；以 Electron `net.request` 实现旧版 `Session.fetch`，保留 Cookie、取消、重定向与 TLS 校验。
- 数据库接口保持原样：现代运行环境继续使用 `node:sqlite`；Win7 使用固定资源路径中的 `better-sqlite3 8.7.0`，原生模块为官方 Electron ABI 110、Windows x64 预编译文件。
- Electron 22 使用 BrowserView 保留原系统标签页，现代环境继续使用 WebContentsView。选择逻辑按 Electron 版本惰性判断，避开旧版不完整的实验接口。
- Win7 构建目标为 Node16/Chrome108；Cheerio 只打包 XML 所需的 slim 入口。
- 新旧 Chromium 使用独立配置目录，避免降级混用浏览器配置。Win7 首次使用需重新激活并登录原系统，不迁移现代 Chromium profile。
- Win7 和现代系统都使用各自官方 Electron 分发中的随包图形组件，并在安装前检查。Win7 使用 Electron22 配套的 `d3dcompiler_47.dll`，Win10/11 使用 Electron44 配套版本，不混用不同内核的 DLL。安装器不替换系统目录内的 DLL。
- 安装前沿用导出文件备份、校验、恢复流程；检查或备份失败时不进入卸载步骤。
- Win7 检查及导出保护助手使用系统自带 CLR2 / .NET3.5，现代系统助手使用 CLR4。根据已取得的 Win7 实际日志，原先 `0x80131700` 是 CLR4 启动失败；此次消除兼容助手对 CLR4 的依赖。图形错误返回23，检查程序其他启动错误返回25，原始退出码和输出单独保留。

## 构建步骤

构建机使用项目要求的现代 Node.js。兼容应用有独立生产依赖，不降级主项目的 Electron。

先准备并校验官方 Electron 22.3.27 Windows x64 解压目录 `.tmp/win7-runtime/22.3.27/x64`，并将官方 Electron ABI 110 的 `better_sqlite3.node` 放入 `compat/win7/node_modules/better-sqlite3/build/Release/`。然后顺序运行：

```powershell
npm install --prefix compat/win7 --ignore-scripts
npm run icons
node scripts/build-windows-update-host.mjs
node scripts/build-export-preserver.mjs
npm run build
npx electron-builder --config electron-builder.universal-modern.cjs --win --x64
npm run build:win7
node scripts/stage-win7-app.mjs
npx electron-builder --config electron-builder.win7.cjs --win --x64
npm run package:universal
```

`package:universal` 只负责组装已生成的两个组件安装器，并非完整一键构建。Win7 打包钩子会重新构建 CLR2 助手；组装时校验两个组件内置助手与当前构建一致，拒绝使用旧助手。现代打包钩子保留并校验官方 Electron 内的 DLL，写入 `graphics-runtime.json`。最终安装文件和 SHA256 清单位于 `release/1.0.21/universal/`。内部组件 EXE 不单独分发。当前最终包 200,262,797 字节，未加入系统补丁。

本轮校验值：

- Electron22 官方 ZIP：`ad723ed7dad32f9459f7a9de1fd6d718cf713c4809c2431503bea62ce8f786e6`
- SQLite 原生模块：`86075d4bf0a25d6d86206144bf793fe5e6e19a581dcd0ae138bcf0170a55fe01`
- 2026-11-11 两套内核均内置图形组件的最终通用安装包：`a3707e08d53948430ebf833e0d81ebae0267210838cb8d3c5755c7d95101b919`

## 验证与限制

以下为11月10日基线记录，本轮补充验证及实际交付状态见其后段落。

- TypeScript 检查及 95 个文件、763 项测试通过。
- 在当前 Windows 10 宿主上，真实 Electron22 测试覆盖 SQLite 落盘与事务、加密会话、Cookie、重定向、取消、BrowserView 标签切换、Excel 生成与读回、Word 解析及后台 HTTPS。
- 导出文件保全及图形组件 NSIS 回归通过；兼容图形组件缺失时退出 23，官方组件存在时通过。
- 最终通用 EXE 的 `/CHECKOS` 在当前 Windows10 上选择 modern，未执行安装。
- 两个最终打包应用使用隔离配置成功启动，预加载接口与 IPC 正常，版本为 1.0.21；未导入用户授权或登录凭据。截图采集未完成有效视觉验收，不能作为界面显示通过的依据。
- 归档路径检查未发现私有目录、密钥文件、会话文件或业务数据库混入。安装包仍未签名。

2026-11-11 补充验证：当前源代码的类型检查及30项安装交接测试通过；真实 NSIS 分流测试覆盖实际 Windows10、模拟 Win7 7600/SP1、子安装器取消码1602、32位及不支持系统拒绝，正确保留 `/S` 和含中文、空格、特殊字符的 `/D` 参数。测试用的系统条件仅替换在临时生成的 NSIS 源码中，正式包不提供环境变量或参数覆盖系统识别的入口。

最终通用 EXE 已真实解包：只有两个组件安装器及 NSIS System 插件，内置组件 SHA256 与本轮构建一致；两套助手实际检查对应官方 DLL 通过，预检查和应用载荷内的 DLL 字节一致，应用 ASAR 与当前构建相同，未夹带配置、会话或业务库。最终 `/CHECKOS /S` 在实际 Windows10 选择 modern 且不触发安装。新版正式程序隔离启动、IPC、授权边界、Canvas/WebGL1/2绘制和像素读回通过，并确认图形进程加载应用目录 DLL；现代 DLL 的微软签名有效。真实 NSIS 七场景覆盖两个内核的有效组件、损坏组件、检查进程失败和现代版旧组件替换，导出文件均保留。Electron22 较早基线的会话请求、SQLite、加密存储、标签切换、表格导出读回、Word解析和后台HTTPS通过。

用户已确认前一个 Win7 安装修复包安装正常；新的通用包尚未在 Win7 完整安装及验收业务回流。Win7 使用的 Electron22 已停止维护，因此现代系统继续使用新内核；Win7 在线更新仍关闭，可使用通用安装包手动升级。本次未更新线上发布或本机正式安装。

本轮内置组件证据位于 `private/deploy/universal-1.0.21-bundled-20261111/`，较早基线验证位于 `private/deploy/universal-1.0.21-20261110/`。最终包核验命令：`node scripts/verify-universal-package.mjs`；分流回归命令：`node scripts/verify-universal-dispatch.mjs`。Win7 运行日志位于 `%APPDATA%\data-fusion-desktop-win7\logs`；安装诊断与导出备份位于 `%APPDATA%\data-fusion-desktop\updates\export-backups`。

官方版本依据：

- https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice
- https://releases.electronjs.org/release/v22.3.27

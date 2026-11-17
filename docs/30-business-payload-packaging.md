# 固定基础包与业务ASAR构建

本流程独立于原完整安装包构建；原 `electron-builder.cjs`、Linux/Win7配置和旧发布通道保持可用。基础包保留原appId、可执行文件名、NSIS导出保护、官方图形组件和Win7原生数据库资源。

## 业务载荷

先完成对应源码构建：现代版本使用 `npm run build` 的 `out/`；Win7使用 `npm run build:win7` 的 `out-win7/`。最终包必须在源码冻结后重新生成，不把早期试验产物当成交付。

```powershell
node scripts/build-business-payload.mjs --version 1.1.0 --platform win32 --arch x64 --variant standard --electron-major 44 --min-shell-version 1.1.0
```

输出 `release/1.1.0/business/win32-x64-standard-electron-44/business-1.1.0.asar` 和 `payload.json`。其他已定义目标为Windows x64/Electron22、Linux x64或ARM64/Electron44，以及Linux ARM64/kirin990/Electron44。

业务包根目录包含精确的 `business.json`、业务package.json、完整out目录及现代版本实际解析的生产依赖。依赖图包含嵌套依赖和已安装peer，排除开发依赖、调试/测试/凭据文件；发现原生node/DLL/SO组件则拒绝构建。Win7已经将业务依赖编译进Node16目标，业务包不复制现代依赖；ABI匹配的better-sqlite3仍由基础包的legacy-runtime资源提供。

业务包不含Electron、用户配置、授权、Cookie、业务数据库或导出文件。同一输出目录下，相同版本的不同字节不能覆盖旧ASAR；本地构建试验可用 `--output-root .tmp/独立试验名`，不会占用正式release版本路径。

后端迁移参数可用 `--backend-origin https://新地址 --backend-revision 2` 指定；只接受完整HTTPS源。它们进入签名业务元数据，不能通过修改默认配置悄悄改变已选定的自定义地址。

## 固定启动壳

```powershell
node scripts/stage-business-shell.mjs --payload release/1.1.0/business/win32-x64-standard-electron-44/payload.json --shell-version 1.1.0
$env:DATA_FUSION_SHELL_STAGE='上一步返回的stage.json完整路径'
npx electron-builder --config electron-builder.shell.cjs --win --x64 --dir
```

基础app.asar精确包含 `business-bootstrap.cjs`、`business-preload.cjs`、`business-startup.html`、`business-updater.cjs`、`shell.json`、`package.json` 六个文件。初始业务包原始字节位于 `resources/business/builtin.asar`。现代Windows保留嵌入式ASAR完整性验证和OnlyLoadAppFromAsar，业务包由可信启动器验签、安全提取并验证后加载，不直接覆盖基础app.asar或动态require外部ASAR。

electron-builder即使发现暂存package.json的dependencies为空，也可能继续回溯工程根目录收集依赖。因此基础配置显式排除node_modules，并在afterPack中枚举最终app.asar、强制精确六文件；不能只凭暂存目录干净就认定基础包没有夹带业务模块。

配置仍保留对应官方Electron自带d3dcompiler_47.dll，构建后逐字节核对来源并生成graphics-runtime.json。Windows完整安装器继续使用旧后台接受的正式文件名和原NSIS安全安装逻辑；Win7生成内部组件名，可与现代组件一起接入通用外层安装器。构建脚本不自动安装、发布或改动现有用户目录。

现代和Win7目录包验证后，可用 `--prepackaged` 分别生成NSIS组件，再生成中文通用安装器：

```powershell
node scripts/build-business-shell-universal.mjs --version 1.1.0 --modern '现代NSIS组件完整路径' --legacy 'Win7组件完整路径' --output-root .tmp/business-pilot-20261117/windows
```

通用安装器保留原操作系统选择规则，使用现代或Win7对应的原生导出保护程序，检查Win7组件内的CLR2配置。它不附带Windows系统补丁、不添加前置安装器，也不强制重启系统。输出 `universal-manifest.json` 记录组件哈希与未签名状态。

## 麒麟基础包

Linux暂存时必须选择对应Linux业务目标；可通过 `--electron-dist` 或 `DATA_FUSION_LINUX_ELECTRON_DIST` 指向已经验证的对应架构官方Electron分发目录。

```powershell
node scripts/stage-business-shell.mjs --payload release/1.1.0/business/linux-arm64-standard-electron-44/payload.json --electron-dist 对应官方ARM64运行时目录
$env:DATA_FUSION_SHELL_STAGE='生成的stage.json完整路径'
npx electron-builder --config electron-builder.shell.linux.cjs --linux --arm64 --dir
node scripts/stage-business-shell-deb.mjs --shell-stage '生成的stage.json完整路径'
```

DEB沿用已验证的便携GNU tar/XZ构建器和独立逐字节校验器。kirin990目标另调用现有私有图形兼容stager，不替换系统库；标准与专用DEB使用原后台认可的中文包名。

固定壳DEB暂存器直接复用原Python构建函数并显式传入候选版本和输出目录。原Python CLI读取根package.json的旧行为保持不变，因此不会为生成候选包改动正式版本号或旧发布目录。

## 构建试验边界

`node --test scripts/business-package.test.mjs`覆盖生产依赖图、完整主进程/前端/模板、敏感文件排除、Win7输出选择、原生文件拒绝、不可覆盖版本、基础公钥与builtin钉住、链接拒绝，以及打包后Linux架构/固定壳依赖回溯等八项检查。

## 2026-11-17候选包验证

最终源码构建后生成了1.1.0候选业务包与基础包，根package.json保持1.0.25。候选产物全部位于 `.tmp/business-pilot-20261117/`，本构建流程没有上传OSS、发布自动更新、安装应用或启动虚拟机。此前使用旧out的结构试验已被本轮候选构建替代。

业务包位于 `business/<目标>/business-1.1.0.asar`，旁边的 `payload.json` 记录完整哈希。五个目标分别为Windows x64/Electron44、Windows x64/Electron22、Linux x64/Electron44、Linux ARM64/Electron44及海思990 ARM64/Electron44。现代业务包约32.5MB，已编译的Win7业务包约4.0MB。

候选基础包如下；路径均相对于本轮候选目录：

| 用途 | 产物 |
| --- | --- |
| Windows通用安装器 | `windows/数据融合助手-兼容通用安装包-1.1.0-x64.exe` |
| Windows现代组件 | `shell/win32-x64-standard-electron-44/数据融合助手-安装包-1.1.0-x64.exe` |
| Windows兼容内部组件 | `shell/win32-x64-standard-electron-22/DataFusion-Win7-Component-1.1.0-x64.exe` |
| 麒麟x64 | `shell/linux-x64-standard-electron-44/数据融合助手-麒麟版-1.1.0-x64.deb` |
| 麒麟ARM64 | `shell/linux-arm64-standard-electron-44/数据融合助手-麒麟版-1.1.0-arm64.deb` |
| 麒麟海思990 | `shell/linux-arm64-kirin990-electron-44/数据融合助手-麒麟海思990版-1.1.0-arm64.deb` |

`packaging-verification.json`记录五路最终目录包检查：基础app.asar约54KB、精确六文件，四个启动器源文件与最终冻结源码逐字节一致，builtin与对应业务包原始字节一致。五路OnlyLoadAppFromAsar保持开启，现代Windows嵌入式ASAR完整性验证开启；Windows官方图形DLL一致，Linux原生ELF架构正确。Linux各 `shell-deb.json` 另记录DEB全部文件字节、权限、root所有者、GNU tar及无PAX扩展的独立验证。

主线程使用最终两个Windows目录包完成真实业务界面与预加载IPC冒烟：7个系统、8个组件、18项政务事项和18项人社业务统计可见，SQLite、设置、加密账号、授权与会话文件、导出文件在两次启动后保留，基础包字节不变。结果位于 `.tmp/business-app-packaged-dEPkpT/result.json`（Electron44）和 `.tmp/business-app-packaged-5tO49P/result.json`（Electron22）。通用外层执行 `/S /CHECKOS` 验证选择modern/x64且无系统前置安装器，没有实际安装。

这些运行验证在当前Windows主机完成，Electron22运行通过不能等同于Win7操作系统实机验收。Linux三路在本轮完成打包与独立静态验证，没有进行麒麟目标系统安装或海思硬件测试。正式发布前应按目标环境继续验证；构建结果本身不修改现有用户数据。

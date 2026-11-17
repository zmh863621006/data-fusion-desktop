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

## 麒麟基础包

Linux暂存时必须选择对应Linux业务目标；可通过 `--electron-dist` 或 `DATA_FUSION_LINUX_ELECTRON_DIST` 指向已经验证的对应架构官方Electron分发目录。

```powershell
node scripts/stage-business-shell.mjs --payload release/1.1.0/business/linux-arm64-standard-electron-44/payload.json --electron-dist 对应官方ARM64运行时目录
$env:DATA_FUSION_SHELL_STAGE='生成的stage.json完整路径'
npx electron-builder --config electron-builder.shell.linux.cjs --linux --arm64 --dir
node scripts/stage-business-shell-deb.mjs --shell-stage '生成的stage.json完整路径'
```

DEB沿用已验证的便携GNU tar/XZ构建器和独立逐字节校验器。kirin990目标另调用现有私有图形兼容stager，不替换系统库；标准与专用DEB使用原后台认可的中文包名。

## 构建试验边界

`node --test scripts/business-package.test.mjs`覆盖生产依赖图、完整主进程/前端/模板、敏感文件排除、Win7输出选择、原生文件拒绝、不可覆盖版本、基础公钥与builtin钉住、链接拒绝，以及打包后Linux架构/固定壳依赖回溯等八项检查。

2026-11-17的现代Windows构建试验使用旧out，实际业务ASAR为32472946字节、3034个文件，已由新运行时原始ASAR解析器读取通过。CLI实际打包的固定基础app.asar为49628字节、精确六文件；固定源逐字节一致，两项ASAR fuses保持开启，官方图形组件匹配。证据在 `.tmp/business-shell-minimal-probe-20261117/`。这些是打包结构和完整性试验，不是最终源码、真实业务或目标OS运行验收；最终交付不能沿用这些摘要。

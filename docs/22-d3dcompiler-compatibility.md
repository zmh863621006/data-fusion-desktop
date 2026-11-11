# D3DCompiler 官方版本与系统组件兼容性诊断

2026-11-04，用户要求实测 `d3dcompiler_47.dll` 能否替换。最初对照时正式版本为1.0.13，先在唯一隔离副本测试，不调整安全软件设置；后续按用户明确请求将系统依赖方案发布为1.0.14，见下文。

## 对照结果

环境为 Windows 10（10.0.19043）、NVIDIA GeForce RTX 3060、Electron 44.3.0。三个场景均使用同一个正式app.asar副本与独立临时用户目录，通过本地虚构后台阻断实际业务请求，没有使用原账号、许可证、会话或业务数据。

| 场景 | 实际加载文件 | 文件版本 | 结果 |
| --- | --- | --- | --- |
| Electron原始分发 | 隔离应用目录的D3DCompiler_47.dll | 10.0.26100.7705 | 通过 |
| 官方系统版本复制到隔离目录 | 隔离应用目录的D3DCompiler_47.dll | 10.0.19041.868 | 通过，仅用于诊断 |
| 隔离应用不携带此DLL | C:\\Windows\\SYSTEM32\\D3DCompiler_47.dll | 10.0.19041.868 | 通过，已核对实际GPU进程模块路径 |

两份DLL均为64位、微软签名校验有效，但签名形式不同：Electron附带文件是嵌入式Authenticode签名；Windows系统文件依赖本机Catalog签名。因此不把本机System32文件直接打包分发，避免降级运行库或错误假设其他机器能验证本机系统目录文件的签名。

每组测试覆盖正式程序启动、预加载与IPC、授权边界、SQLite与虚构后台、单实例及截图。图形部分实际验证Canvas 2D像素、WebGL 1/2顶点/片元着色器编译、链接、绘制和像素读回，渲染器均为Direct3D11，未通过关闭GPU绕开依赖。额外调用各版本D3DCompile，成功编译vs_5_0与ps_5_0；D3DCompile、D3DCompile2、D3DDisassemble导出均存在。原版和系统加载版界面截图已人工检查，无空白窗口或可见异常。

## 结论与范围

本机实测证明，可以使用Windows自带的同接口D3DCompiler_47组件，而非强制从应用目录加载Electron附带版本；这比将本机旧系统文件重新分发更合适。该结果不代表可以把任意其他DLL改名替代，也不代表已验收全部Windows 10/11版本、其他显卡或五个原业务网站。

最初诊断证据支持进一步评估系统组件依赖方案；不能把单台电脑结果当作所有Windows版本或显卡的兼容保证。仅移除新包中的文件也不意味着旧版本应用目录的同名文件一定消失，因此实际升级还需预检查及遗留文件处理。

本次未在360环境验收，不能保证替换版本或改为系统加载后全部安装提示消失；当前未签名安装器的其他文件操作仍可能被安全软件提示。

## 验证记录

- 汇总：`.tmp/d3dcompiler-compatibility-1ekqsH/report.json`
- 原版报告：`.tmp/release-qa-1793794758585/report.json`
- 系统文件副本报告：`.tmp/release-qa-1793794787516/report.json`
- 直接系统加载报告：`.tmp/release-qa-1793794816108/report.json`
- 每份正式程序报告旁的 `graphics.json` 保存绘制结果与实际加载模块路径，`packaged-activation.png` 保存界面截图。
- 重现命令：`node scripts/diagnose-d3dcompiler-compatibility.mjs`。脚本仅在 `.tmp` 唯一目录创建副本；测试完成后将副本恢复到原DLL，保留诊断证据，正式产物不改动。

官方接口依据：[Microsoft D3DCompile](https://learn.microsoft.com/en-us/windows/win32/api/d3dcompiler/nf-d3dcompiler-d3dcompile)、[Microsoft D3DCompile2](https://learn.microsoft.com/en-us/windows/win32/api/d3dcompiler/nf-d3dcompiler-d3dcompile2)。

## 1.0.14 实施与发布

用户明确要求新建1.0.14并上线，未复用已经发布的1.0.13。`scripts/use-system-graphics.cjs` 在经过目录和PE架构检查的新打包输出中移除随包编译器，写入 `resources/system-graphics.json` 依赖标记；Electron原始分发和Windows系统文件均不改动。

`resources/system-graphics.cs` 编译进现有64位导出助手，以固定 `CheckGraphics` 命令检查真实OS目录中的组件及接口，未提供环境变量或下载配置覆盖DLL目录的入口。NSIS在备份/卸载旧版前执行检查，失败23退出；恢复导出后，只移除安装目录同名旧文件，删除受阻则24退出并保留导出及恢复副本。真实NSIS宏覆盖系统缺失和旧DLL锁定失败路径，确认相应阶段不继续；正常升级场景旧副本消失。

最终NSIS内层载荷和ZIP检查均证明DLL未随包携带，且原生预检查可用。真实正式1.0.14进程通过Canvas、WebGL1/2和像素测试，并确认GPU进程实际加载 `C:\\Windows\\System32\\D3DCompiler_47.dll`；未通过禁用GPU绕开依赖。验收及线上记录见Windows分发文档和 `private/deploy/update-1.0.14-20261104/`。

系统缺失/加载失败的预检查及遗留清理已实现，Windows11和其他显卡仍未实际验收。当前发布供用户进行真实兼容性及360测试，不宣称已解决所有安装提示。

## 2026-11-10：Win7 图形兼容单项测试包

用户截图的诊断目录为 `1.0.20-8320-30711012/installer-graphics.log`，提示来自旧版系统图形组件检查。截图没有日志正文，因此不据此断定具体是文件缺失、加载失败还是检查程序异常。本轮仅处理 Win7 安装中的图形组件问题，不继续系统补丁自动补装方案。

单独交付 `数据融合助手-Win7图形兼容测试版-1.0.21-x64.exe`，80,486,823 字节。使用已构建的 Electron22 兼容应用，安装前及运行时均携带同一份官方 `d3dcompiler_47.dll`，不要求 Windows 系统目录已有此文件。应用 app.asar 与前一兼容构建一致，业务逻辑不变；本测试包不包含 SP1、.NET 或其他系统补丁安装器。

兼容预检查日志补充组件来源、文件版本及加载失败时的 Win32 错误码；NSIS 的图形诊断日志同时注明安装包版本和图形检查模式，便于区分旧包与兼容包。

真实 NSIS 隔离回归验证：模拟系统目录缺少图形组件时，携带官方 DLL 的兼容分支通过；无效 DLL 在旧程序卸载前停止；现代系统分支仍拒绝缺失系统组件的场景。另验证原有现代分支的正常、遗留文件、系统缺失和占用四场景，均保留导出数据。

对最终 EXE 实际解包，确认预检查与应用载荷均包含同一官方 DLL，内置助手为本轮构建，调用解出的 `CheckLegacyGraphics` 成功。验证宿主为 Windows10，Win7 7600 的实际安装和运行尚未验收。未安装本机正式应用，也未上线。

证据：`private/deploy/win7-graphics-1.0.21-20261110/`。

## 2026-11-11：读取 Win7 实际日志后的安装检查修复

通过用户提供的宿主机凭据确认 RDP 13389 转发到 Win7 的 `192.168.178.130:3389`。VMware Tools 未运行、Win7 管理共享及 WMI 拒绝访问，随后只读解析宿主机正在使用的 VMDK，提取用户截图指向的那一份 `1.0.21-5940-6225984/installer-graphics.log`，未挂载或写入虚拟磁盘。日志中的真实退出码为 `-2146232576`（`0x80131700`），没有任何 DLL 检查输出，说明 CLR4 启动失败，不能据此断定图形 DLL 不兼容。对相关运行时文件的定点检查确认，Win7 的 CLR2 和 System.Web.Extensions 3.5 存在，CLR4 文件不存在。

兼容版安装检查和导出保护助手改为 CLR2 / .NET3.5 目标，复用同一套保护逻辑，仅将少量 .NET4 专用 API 改为旧运行时等价方法。Win7 打包钩子构建独立的 `resources/win7-compat` 助手和运行时配置，现代 Windows 助手保持 CLR4 目标。安装宏只对 Win7 选择兼容助手；真实图形错误返回23，其余检查程序启动错误返回25，并保留原始退出码及输出，避免再把 CLR 启动失败误报成图形错误。

重打包为 `数据融合助手-Win7安装修复版-1.0.21-x64.exe`，80,487,196 字节，SHA256 `4f3dce827c64ce17b16a611b2236355622f63985ecff0e4dbb22356a1faf7426`。不包含操作系统补丁或 .NET 安装器，不发布线上。真实 NSIS 四场景（有效 DLL、无效 DLL、检查程序启动错误、现代系统缺失对照）通过；两个运行时目标的导出保护回归通过。最终 EXE 中解出的兼容助手实际输出 `checker_runtime=2.0.50727.9151`，图形检查和导出备份恢复成功，预检查及应用载荷中的官方 DLL 一致。

上述可执行验证宿主为 Windows10；已取得 Win7 真实失败日志，但修复包尚未在 Win7 中执行完整安装。证据见同目录 `guest-installer-graphics.log` 和 `clr2-fixed-artifact.json`。重现最终包验证：`node scripts/verify-packaged-win7-installer.mjs`。

## 2026-11-11：用户要求恢复完整内置分发

用户明确确认暂不再针对360调整分发内容，要求以应用完整性和兼容性为准，将 Win10/11 图形组件也恢复到应用内部。此决定替代前述现代版依赖系统组件的默认策略；未改变安全软件设置，也未自动结束任何安全软件进程。

现代构建改用 `scripts/use-bundled-graphics.cjs`，保留官方 Electron44 配套 DLL，核对 PE x64 架构、与原分发字节一致及 SHA256，写入 `resources/graphics-runtime.json`。实际 DLL 版本为 `10.0.26100.7705`，微软 Authenticode 签名有效。Win7 继续使用 Electron22 自带版本，不将一套内核的 DLL 强行复用于另一套内核。

现代安装预检查改为 `CheckBundledGraphics`，检查固定临时目录中的同一官方 DLL，不依赖系统目录已有该文件。移除安装完成后删除应用 DLL 的旧逻辑；更新错误提示同步改为检查安装包组件。真实 NSIS 七场景验证新装、旧本地组件替换、无效组件及检查进程失败；失败在旧程序卸载前停止，导出保护回归通过。最终现代组件实际解包后，预检查 DLL 与应用载荷 DLL 均等于官方分发，解出的助手检查及导出备份恢复成功。

实际打包程序在 Windows10 上完成 Canvas、WebGL1/2 着色器绘制和像素读回；核对图形进程的模块列表，确认实际加载应用目录 `d3dcompiler_47.dll`。最终通用包为 `数据融合助手-兼容通用安装包-1.0.21-x64.exe`，200,262,797 字节，SHA256 `a3707e08d53948430ebf833e0d81ebae0267210838cb8d3c5755c7d95101b919`，仅本地交付，未发布线上。

本轮证据：`private/deploy/universal-1.0.21-bundled-20261111/`。用户已确认较早 Win7 安装修复包安装成功；新的通用包未在 Win7/Win11 执行完整安装验收，不据此承诺所有系统与显示驱动组合均已实测。

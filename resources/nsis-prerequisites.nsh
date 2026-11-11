; Native bootstrap: deliberately has no .NET or PowerShell dependency.
!include "StdUtils.nsh"
!include "x64.nsh"

!ifndef BOOTSTRAP_REGISTRY_KEY
  !define BOOTSTRAP_REGISTRY_KEY "Software\DataFusionInstaller\${APP_VERSION}"
!endif
!ifndef BOOTSTRAP_RUNONCE_NAME
  !define BOOTSTRAP_RUNONCE_NAME "DataFusionPrerequisites-${APP_VERSION}"
!endif
!ifndef BOOTSTRAP_RUNONCE_KEY
  !define BOOTSTRAP_RUNONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!endif
!ifndef BOOTSTRAP_CACHE
  !define BOOTSTRAP_CACHE "$LOCALAPPDATA\DataFusionInstaller\${APP_VERSION}"
!endif
!ifndef BOOTSTRAP_DETECT
  !define BOOTSTRAP_DETECT DetectInstalledPrerequisites
!endif
!ifndef BOOTSTRAP_SHELL_VERB
  !define BOOTSTRAP_SHELL_VERB "runas"
!endif
!ifndef BOOTSTRAP_LAUNCH
  !define BOOTSTRAP_LAUNCH ExecutePrerequisiteShell
!endif

Var MissingSP1
Var MissingNet
Var MissingSSU
Var MissingSHA2
Var PrerequisiteCache
Var PrerequisiteLogFile
Var PrerequisitePhase
Var PrerequisitePreviousPhase
Var PrerequisiteFile
Var PrerequisiteExecutable
Var PrerequisiteHash
Var PrerequisiteArguments
Var PrerequisiteExit
Var PrerequisiteFailure
Var PrerequisiteText
Var PrerequisiteConsent
Var PrerequisiteResume

Function DetectInstalledPrerequisites
  StrCpy $MissingSP1 0
  StrCpy $MissingNet 0
  StrCpy $MissingSSU 0
  StrCpy $MissingSHA2 0
  ${If} ${IsWin7}
    ${IfNot} ${AtLeastServicePack} 1
      StrCpy $MissingSP1 1
    ${EndIf}
  ${EndIf}
  ; UpdateHost uses APIs introduced after .NET4.0. Full/Install alone is insufficient.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  SetRegView 32
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 394802
  ${AndIf} $1 < 394802
    StrCpy $MissingNet 1
  ${EndIf}
  ${If} ${IsWin7}
  ${AndIf} $MissingSP1 == 0
  ${AndIf} $MissingNet == 1
    Call DetectWindows7SupportUpdates
  ${EndIf}
FunctionEnd

Function DetectWindows7SupportUpdates
  ; .NET4.8 on a fresh SP1 installation needs Windows SHA-2 update support.
  ; Recognize both installed and superseded CBS packages and newer servicing stacks.
  StrCpy $MissingSSU 1
  StrCpy $MissingSHA2 1
  SetRegView 64
  StrCpy $2 0
  cbs_next:
  ClearErrors
  EnumRegKey $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\Packages" $2
  ${If} ${Errors}
    SetRegView 32
    Return
  ${EndIf}
  IntOp $2 $2 + 1
  ReadRegDWORD $4 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\Packages\$0" "CurrentState"
  ${If} $4 == 112
  ${OrIf} $4 == 80
    StrCpy $3 $0 21
    ${If} $3 == "Package_for_KB4474419"
      StrCpy $MissingSHA2 0
    ${EndIf}
    ${If} $3 == "Package_for_KB4490628"
    ${OrIf} $3 == "Package_for_KB4536952"
    ${OrIf} $3 == "Package_for_KB4550735"
    ${OrIf} $3 == "Package_for_KB4555449"
    ${OrIf} $3 == "Package_for_KB4565354"
    ${OrIf} $3 == "Package_for_KB4570673"
    ${OrIf} $3 == "Package_for_KB4592510"
    ${OrIf} $3 == "Package_for_KB5004378"
    ${OrIf} $3 == "Package_for_KB5017397"
      StrCpy $MissingSSU 0
    ${EndIf}
  ${EndIf}
  Goto cbs_next
FunctionEnd

Function PrerequisiteLog
  FileOpen $9 "$PrerequisiteLogFile" a
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    FileWrite $9 "$PrerequisiteText$\r$\n"
    FileClose $9
  ${EndIf}
FunctionEnd

Function ClearPrerequisiteResume
  DeleteRegValue HKCU "${BOOTSTRAP_RUNONCE_KEY}" "${BOOTSTRAP_RUNONCE_NAME}"
  DeleteRegValue HKCU "${BOOTSTRAP_REGISTRY_KEY}" "Phase"
FunctionEnd

Function StopPrerequisite
  Call ClearPrerequisiteResume
  StrCpy $PrerequisiteText "failed phase=$PrerequisitePhase code=$PrerequisiteExit reason=$PrerequisiteFailure"
  Call PrerequisiteLog
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "运行环境准备未完成，应用安装尚未开始。$\r$\n$PrerequisiteFailure$\r$\n错误码：$PrerequisiteExit$\r$\n日志：$PrerequisiteLogFile"
  ${EndIf}
  SetErrorLevel $PrerequisiteExit
  Quit
FunctionEnd

Function RememberPrerequisiteResume
  ; Persist a private copy because the original may be launched from a temporary
  ; download directory. The app installer still runs under the original user.
  ${If} $EXEPATH != "$PrerequisiteCache\Setup.exe"
    ClearErrors
    CopyFiles /SILENT "$EXEPATH" "$PrerequisiteCache\Setup.exe"
    ${If} ${Errors}
      StrCpy $PrerequisiteExit 33
      StrCpy $PrerequisiteFailure "无法保存重启续装文件，请检查磁盘空间。"
      Call StopPrerequisite
    ${EndIf}
    ${StdUtils.HashFile} $0 "SHA2-256" "$EXEPATH"
    ${StdUtils.HashFile} $1 "SHA2-256" "$PrerequisiteCache\Setup.exe"
    ${If} $0 == ""
    ${OrIf} $0 != $1
      StrCpy $PrerequisiteExit 33
      StrCpy $PrerequisiteFailure "重启续装文件校验失败。"
      Call StopPrerequisite
    ${EndIf}
  ${EndIf}
  ClearErrors
  WriteRegStr HKCU "${BOOTSTRAP_REGISTRY_KEY}" "Phase" "$PrerequisitePhase"
  WriteRegStr HKCU "${BOOTSTRAP_RUNONCE_KEY}" "${BOOTSTRAP_RUNONCE_NAME}" '$\"$PrerequisiteCache\Setup.exe$\" /RESUME /INSTALLPREREQUISITES $ForwardArguments'
  ${If} ${Errors}
    StrCpy $PrerequisiteExit 33
    StrCpy $PrerequisiteFailure "无法登记重启后继续安装，请联系管理员。"
    Call StopPrerequisite
  ${EndIf}
FunctionEnd

Function RebootBeforeContinuing
  StrCpy $PrerequisiteText "reboot_required phase=$PrerequisitePhase exit=$PrerequisiteExit"
  Call PrerequisiteLog
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONINFORMATION "运行组件已安装，需要重启电脑后继续。$\r$\n请保存工作并手动重启；下次登录后安装器会自动继续。$\r$\n应用尚未开始安装，日志：$PrerequisiteLogFile"
  ${EndIf}
  ; Never force a reboot, including /S deployments. 3010 is the standard
  ; successful-install/reboot-needed result for the deployment administrator.
  SetErrorLevel 3010
  Quit
FunctionEnd

Function VerifyAndRunPrerequisite
  ClearErrors
  ${StdUtils.HashFile} $0 "SHA2-256" "$PrerequisiteFile"
  ${If} $0 != $PrerequisiteHash
    StrCpy $PrerequisiteExit 33
    StrCpy $PrerequisiteFailure "官方组件文件校验失败，未执行安装。请重新获取安装包。"
    Call StopPrerequisite
  ${EndIf}
  Call RememberPrerequisiteResume
  StrCpy $PrerequisiteText "install_begin phase=$PrerequisitePhase sha256=$PrerequisiteHash"
  Call PrerequisiteLog
  ; Elevate only the fixed, verified Microsoft component. The outer installer
  ; and eventual per-user application install retain their original identity.
  Call ${BOOTSTRAP_LAUNCH}
  ${If} $0 != "ok"
    StrCpy $PrerequisiteExit 34
    StrCpy $PrerequisiteFailure "组件安装未启动，可能取消了管理员授权。"
    Call StopPrerequisite
  ${EndIf}
  ${StdUtils.WaitForProcEx} $PrerequisiteExit $1
  StrCpy $PrerequisiteText "install_end phase=$PrerequisitePhase exit=$PrerequisiteExit"
  Call PrerequisiteLog
  ${If} $PrerequisiteExit == 3010
  ${OrIf} $PrerequisiteExit == 1641
    Call RebootBeforeContinuing
  ${EndIf}
  ${If} $PrerequisiteExit != 0
  ${AndIf} $PrerequisiteExit != 2359302
    StrCpy $PrerequisiteFailure "微软组件安装失败，请保留安装日志后重试。"
    StrCpy $PrerequisiteExit 35
    Call StopPrerequisite
  ${EndIf}
FunctionEnd

Function ExecutePrerequisiteShell
  ; NSIS is a 32-bit launcher. Resolve the native System32 update service before
  ; elevation; do not pass a Sysnative alias to the elevated 64-bit broker.
  ${If} $PrerequisitePhase == "SSU"
  ${OrIf} $PrerequisitePhase == "SHA2"
    ${DisableX64FSRedirection}
  ${EndIf}
  ${StdUtils.ExecShellWaitEx} $0 $1 "$PrerequisiteExecutable" "${BOOTSTRAP_SHELL_VERB}" "$PrerequisiteArguments"
  ${If} $PrerequisitePhase == "SSU"
  ${OrIf} $PrerequisitePhase == "SHA2"
    ${EnableX64FSRedirection}
  ${EndIf}
FunctionEnd

Function PreparePrerequisites
  StrCpy $PrerequisiteCache "${BOOTSTRAP_CACHE}"
  CreateDirectory "$PrerequisiteCache"
  StrCpy $PrerequisiteLogFile "$PrerequisiteCache\prerequisites.log"
  Call ${BOOTSTRAP_DETECT}
  StrCpy $PrerequisiteText "detected missing_sp1=$MissingSP1 missing_net=$MissingNet missing_ssu=$MissingSSU missing_sha2=$MissingSHA2"
  Call PrerequisiteLog
  ReadRegStr $PrerequisitePreviousPhase HKCU "${BOOTSTRAP_REGISTRY_KEY}" "Phase"
  ClearErrors
  ${GetOptions} $ForwardArguments "/RESUME" $PrerequisiteResume
  ${IfNot} ${Errors}
    ${If} $PrerequisitePreviousPhase == "SP1"
    ${AndIf} $MissingSP1 == 1
      StrCpy $PrerequisitePhase "SP1"
      StrCpy $PrerequisiteExit 35
      StrCpy $PrerequisiteFailure "重启后 SP1 仍未生效，已停止自动重试。请查看微软安装日志。"
      Call StopPrerequisite
    ${EndIf}
    ${If} $PrerequisitePreviousPhase == "NET48"
    ${AndIf} $MissingNet == 1
      StrCpy $PrerequisitePhase "NET48"
      StrCpy $PrerequisiteExit 35
      StrCpy $PrerequisiteFailure "重启后 .NET 仍未就绪，已停止自动重试。请查看微软安装日志。"
      Call StopPrerequisite
    ${EndIf}
    ${If} $PrerequisitePreviousPhase == "SSU"
    ${AndIf} $MissingSSU == 1
      StrCpy $PrerequisitePhase "SSU"
      StrCpy $PrerequisiteExit 35
      StrCpy $PrerequisiteFailure "重启后 Windows 更新组件仍未就绪，已停止自动重试。"
      Call StopPrerequisite
    ${EndIf}
    ${If} $PrerequisitePreviousPhase == "SHA2"
    ${AndIf} $MissingSHA2 == 1
      StrCpy $PrerequisitePhase "SHA2"
      StrCpy $PrerequisiteExit 35
      StrCpy $PrerequisiteFailure "重启后 Windows 签名支持组件仍未就绪，已停止自动重试。"
      Call StopPrerequisite
    ${EndIf}
  ${EndIf}
  ${If} $MissingSP1 == 0
  ${AndIf} $MissingNet == 0
    Call ClearPrerequisiteResume
    Return
  ${EndIf}
  ; A normal interactive installation has a single clear consent prompt.
  ; Unattended app updates must not unexpectedly install an OS service pack.
  ClearErrors
  ${GetOptions} $ForwardArguments "/INSTALLPREREQUISITES" $PrerequisiteConsent
  ${If} ${Errors}
    ${If} ${Silent}
      StrCpy $PrerequisiteExit 32
      StrCpy $PrerequisiteFailure "静默部署需明确指定 /INSTALLPREREQUISITES 才可补装系统组件。"
      Call StopPrerequisite
    ${EndIf}
    StrCpy $PrerequisiteText ""
    ${If} $MissingSP1 == 1
      StrCpy $PrerequisiteText "$PrerequisiteText$\r$\n• Windows 7 Service Pack 1（系统补丁）"
    ${EndIf}
    ${If} $MissingNet == 1
      StrCpy $PrerequisiteText "$PrerequisiteText$\r$\n• Microsoft .NET Framework 4.8"
    ${EndIf}
    ${If} $MissingSSU == 1
    ${OrIf} $MissingSHA2 == 1
      StrCpy $PrerequisiteText "$PrerequisiteText$\r$\n• Windows 7 更新及签名支持补丁"
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "检测到缺少以下运行环境：$PrerequisiteText$\r$\n$\r$\n安装器可自动安装随包提供的微软官方组件。期间需要管理员授权，可能需要重启。是否开始准备？" IDYES consent_granted
    SetErrorLevel 1223
    Quit
  ${EndIf}
  consent_granted:
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ${If} $MissingSP1 == 1
    StrCpy $PrerequisitePhase "SP1"
    DetailPrint "正在准备 Windows 7 SP1，请耐心等待……"
    ClearErrors
    File /oname=Windows7-SP1.exe "${PREREQUISITE_SP1_FILE}"
    StrCpy $PrerequisiteFile "$PLUGINSDIR\Windows7-SP1.exe"
    StrCpy $PrerequisiteExecutable "$PrerequisiteFile"
    StrCpy $PrerequisiteHash "${PREREQUISITE_SP1_SHA256}"
    StrCpy $PrerequisiteArguments "/quiet /norestart"
    ${If} ${Errors}
      StrCpy $PrerequisiteExit 33
      StrCpy $PrerequisiteFailure "系统补丁提取失败，请检查磁盘空间。"
      Call StopPrerequisite
    ${EndIf}
    Call VerifyAndRunPrerequisite
    ; Never install .NET or the app into a half-updated operating system.
    Call RebootBeforeContinuing
  ${EndIf}
  ${If} $MissingSSU == 1
    StrCpy $PrerequisitePhase "SSU"
    DetailPrint "正在准备 Windows 更新组件……"
    File /oname=SSU.msu "${PREREQUISITE_SSU_FILE}"
    StrCpy $PrerequisiteFile "$PLUGINSDIR\SSU.msu"
    StrCpy $PrerequisiteExecutable "$WINDIR\System32\wusa.exe"
    StrCpy $PrerequisiteHash "${PREREQUISITE_SSU_SHA256}"
    StrCpy $PrerequisiteArguments '$\"$PrerequisiteFile$\" /quiet /norestart'
    Call VerifyAndRunPrerequisite
  ${EndIf}
  ${If} $MissingSHA2 == 1
    StrCpy $PrerequisitePhase "SHA2"
    DetailPrint "正在准备 Windows 签名支持组件……"
    File /oname=SHA2.msu "${PREREQUISITE_SHA2_FILE}"
    StrCpy $PrerequisiteFile "$PLUGINSDIR\SHA2.msu"
    StrCpy $PrerequisiteExecutable "$WINDIR\System32\wusa.exe"
    StrCpy $PrerequisiteHash "${PREREQUISITE_SHA2_SHA256}"
    StrCpy $PrerequisiteArguments '$\"$PrerequisiteFile$\" /quiet /norestart'
    Call VerifyAndRunPrerequisite
    Call RebootBeforeContinuing
  ${EndIf}
  ${If} $MissingNet == 1
    StrCpy $PrerequisitePhase "NET48"
    DetailPrint "正在安装 Microsoft .NET Framework 4.8……"
    ClearErrors
    File /oname=NET48.exe "${PREREQUISITE_NET48_FILE}"
    StrCpy $PrerequisiteFile "$PLUGINSDIR\NET48.exe"
    StrCpy $PrerequisiteExecutable "$PrerequisiteFile"
    StrCpy $PrerequisiteHash "${PREREQUISITE_NET48_SHA256}"
    StrCpy $PrerequisiteArguments "/passive /norestart /log $\"$PrerequisiteCache\net48-install.log$\""
    ${If} ${Errors}
      StrCpy $PrerequisiteExit 33
      StrCpy $PrerequisiteFailure "运行组件提取失败，请检查磁盘空间。"
      Call StopPrerequisite
    ${EndIf}
    Call VerifyAndRunPrerequisite
    Call ${BOOTSTRAP_DETECT}
    ${If} $MissingNet == 1
      StrCpy $PrerequisiteExit 35
      StrCpy $PrerequisiteFailure ".NET 安装结束后检测仍未通过，已停止安装应用。"
      Call StopPrerequisite
    ${EndIf}
  ${EndIf}
  Call ClearPrerequisiteResume
  StrCpy $PrerequisiteText "environment_ready"
  Call PrerequisiteLog
FunctionEnd

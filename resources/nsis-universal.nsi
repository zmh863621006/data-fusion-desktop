Unicode true
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!ifdef HUIZHOU_PRODUCT
  Name "惠州数据融合助手"
  Caption "惠州数据融合助手 安装"
!else
  Name "数据融合助手"
  Caption "数据融合助手 安装"
!endif
OutFile "${OUTPUT_FILE}"
Icon "${APP_ICON}"
RequestExecutionLevel user
ManifestSupportedOS all
SilentInstall normal
ShowInstDetails show
AutoCloseWindow true
Page instfiles
SetCompress off
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
VIProductVersion "${APP_VERSION}.0"
!ifdef HUIZHOU_PRODUCT
  VIAddVersionKey /LANG=2052 "ProductName" "惠州数据融合助手"
  VIAddVersionKey /LANG=2052 "FileDescription" "惠州数据融合助手通用安装程序"
!else
  VIAddVersionKey /LANG=2052 "ProductName" "数据融合助手"
  VIAddVersionKey /LANG=2052 "FileDescription" "数据融合助手通用安装程序"
!endif
VIAddVersionKey /LANG=2052 "CompanyName" "数据融合助手"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"

Var SelectedRuntime
Var SelectedInstaller
Var ForwardArguments
Var CheckOnly
Var BootstrapMutex

Function .onInit
  ${IfNot} ${RunningX64}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "此安装包适用于64位 Windows 7、Windows 10/11。当前系统不是支持的64位环境。"
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}
  ${If} ${AtLeastWin10}
    StrCpy $SelectedRuntime "modern"
  ${ElseIf} ${IsWin7}
    StrCpy $SelectedRuntime "legacy"
  ${Else}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "此安装包支持64位 Windows 7、Windows 10/11。当前 Windows 版本不在支持范围内。"
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}
  ${GetParameters} $ForwardArguments
  ClearErrors
  ${GetOptions} $ForwardArguments "/CHECKOS" $CheckOnly
  ${IfNot} ${Errors}
    ClearErrors
    !ifdef HUIZHOU_PRODUCT
      FileOpen $0 "$TEMP\HuizhouDataFusion-Universal-${APP_VERSION}-platform.txt" w
    !else
      FileOpen $0 "$TEMP\DataFusion-Universal-${APP_VERSION}-platform.txt" w
    !endif
    ${If} ${Errors}
      SetErrorLevel 23
      Quit
    ${EndIf}
    FileWrite $0 "version=${APP_VERSION}$\r$\nruntime=$SelectedRuntime$\r$\narch=x64$\r$\nprerequisites=none$\r$\n"
    FileClose $0
    SetErrorLevel 0
    Quit
  ${EndIf}
  !ifdef HUIZHOU_PRODUCT
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\HuizhouDataFusionUniversal-${APP_VERSION}") p .r0 ?e'
  !else
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\DataFusionUniversal-${APP_VERSION}") p .r0 ?e'
  !endif
  Pop $1
  StrCpy $BootstrapMutex $0
  ${If} $1 == 183
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "已有一个数据融合助手安装程序正在运行，请先完成或关闭该安装程序。"
    ${EndIf}
    SetErrorLevel 1618
    Quit
  ${EndIf}
  ${If} $BootstrapMutex == 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "安装环境初始化失败，请重新运行安装程序。错误码：$1"
    ${EndIf}
    SetErrorLevel 34
    Quit
  ${EndIf}
FunctionEnd

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  ${If} $SelectedRuntime == "modern"
    File /oname=DataFusion-Modern-Setup.exe "${MODERN_INSTALLER}"
    StrCpy $SelectedInstaller "$PLUGINSDIR\DataFusion-Modern-Setup.exe"
  ${Else}
    File /oname=DataFusion-Legacy-Setup.exe "${LEGACY_INSTALLER}"
    StrCpy $SelectedInstaller "$PLUGINSDIR\DataFusion-Legacy-Setup.exe"
  ${EndIf}
  ${If} ${Errors}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "安装组件提取失败，请确认临时目录和磁盘空间后重试。"
    ${EndIf}
    SetErrorLevel 23
    Quit
  ${EndIf}
  ; Arguments remain data passed to a fixed local executable. No command shell
  ; is involved. /S and /D are preserved for the existing verified updater.
  ClearErrors
  ExecWait '"$SelectedInstaller" $ForwardArguments' $0
  ${If} ${Errors}
    SetErrorLevel 23
  ${Else}
    SetErrorLevel $0
  ${EndIf}
SectionEnd

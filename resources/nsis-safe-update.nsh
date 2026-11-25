; Never terminate an application instance, including from the old-version uninstaller.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 != 603
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "请先关闭正在运行的数据融合助手，再重新安装。安装程序不会强制结束其他窗口。"
    ${EndIf}
    SetErrorLevel 12
    Quit
  ${EndIf}
!macroend

; This section runs BEFORE the install section invokes the old uninstaller, which
; can recursively remove exports alongside the program. Keep backups outside it.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var exportBackupPath
    Var exportPreviousUser
    Var exportPreviousMachine
    Section "-Preserve exported files"
      SectionIn RO
      !insertmacro customCheckAppRunning
      InitPluginsDir
      !ifdef DATA_FUSION_WIN7_RUNTIME
        File /oname=$PLUGINSDIR\DataFusion.ExportPreserver.exe "${BUILD_RESOURCES_DIR}\win7-compat\DataFusion.ExportPreserver.exe"
        File /oname=$PLUGINSDIR\DataFusion.ExportPreserver.exe.config "${BUILD_RESOURCES_DIR}\win7-compat\DataFusion.ExportPreserver.exe.config"
      !else
        File /oname=$PLUGINSDIR\DataFusion.ExportPreserver.exe "${BUILD_RESOURCES_DIR}\DataFusion.ExportPreserver.exe"
      !endif
      ReadRegStr $exportPreviousUser HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $exportPreviousMachine HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      System::Call 'kernel32::GetCurrentProcessId() i .r0'
      System::Call 'kernel32::GetTickCount() i .r1'
      !ifdef DATA_FUSION_HUIZHOU
        StrCpy $exportBackupPath "$APPDATA\huizhou-data-fusion-desktop\updates\export-backups\${VERSION}-$0-$1"
      !else
        StrCpy $exportBackupPath "$APPDATA\data-fusion-desktop\updates\export-backups\${VERSION}-$0-$1"
      !endif
      ; Environment transport preserves Unicode, quotes and trailing backslashes.
      ; The fixed helper does not run scripts or change Windows security policies.
      System::Call 'kernel32::SetEnvironmentVariable(t "DATA_FUSION_EXPORT_INSTALL", t "$INSTDIR")'
      System::Call 'kernel32::SetEnvironmentVariable(t "DATA_FUSION_EXPORT_BACKUP", t "$exportBackupPath")'
      System::Call 'kernel32::SetEnvironmentVariable(t "DATA_FUSION_EXPORT_PREVIOUS_USER", t "$exportPreviousUser")'
      System::Call 'kernel32::SetEnvironmentVariable(t "DATA_FUSION_EXPORT_PREVIOUS_MACHINE", t "$exportPreviousMachine")'
      ; Check the matching official bundled DLL before backup/uninstall can change the old application.
      !ifdef DATA_FUSION_WIN7_RUNTIME
        File /oname=$PLUGINSDIR\d3dcompiler_47.dll "${BUILD_RESOURCES_DIR}\..\.tmp\win7-runtime\22.3.27\x64\d3dcompiler_47.dll"
        nsExec::ExecToStack '"$PLUGINSDIR\DataFusion.ExportPreserver.exe" CheckLegacyGraphics'
      !else
        File /oname=$PLUGINSDIR\d3dcompiler_47.dll "${BUILD_RESOURCES_DIR}\..\node_modules\electron\dist\d3dcompiler_47.dll"
        nsExec::ExecToStack '"$PLUGINSDIR\DataFusion.ExportPreserver.exe" CheckBundledGraphics'
      !endif
      Pop $R0
      Pop $R1
      ${If} $R0 != 0
        CreateDirectory "$exportBackupPath"
        FileOpen $R2 "$exportBackupPath\installer-graphics.log" w
        FileWrite $R2 "package-version=${VERSION}$\r$\n"
        !ifdef DATA_FUSION_WIN7_RUNTIME
          FileWrite $R2 "graphics-mode=electron22-bundled$\r$\n"
        !else
          FileWrite $R2 "graphics-mode=electron-bundled$\r$\n"
        !endif
        FileWrite $R2 "exit=$R0$\r$\n$R1$\r$\n"
        ${If} $R0 == 23
          StrCpy $R3 23
          FileWrite $R2 "error-type=graphics-runtime$\r$\n"
        ${Else}
          StrCpy $R3 25
          FileWrite $R2 "error-type=checker-failed$\r$\n"
        ${EndIf}
        FileClose $R2
        ${IfNot} ${Silent}
          StrCpy $R4 $R1 400
          ${If} $R3 == 25
            MessageBox MB_OK|MB_ICONSTOP "安装检查程序未能正常运行，已停止安装，原程序未卸载。$\r$\n检查退出码：$R0$\r$\n$R4$\r$\n诊断日志：$exportBackupPath\installer-graphics.log"
          ${Else}
            !ifdef DATA_FUSION_WIN7_RUNTIME
            MessageBox MB_OK|MB_ICONSTOP "兼容图形组件加载失败，已停止安装，原程序未卸载。$\r$\n检查退出码：$R0$\r$\n$R4$\r$\n诊断日志：$exportBackupPath\installer-graphics.log"
            !else
            MessageBox MB_OK|MB_ICONSTOP "安装包内的图形组件加载失败，已停止升级，原程序未卸载。$\r$\n检查退出码：$R0$\r$\n$R4$\r$\n诊断日志：$exportBackupPath\installer-graphics.log"
            !endif
          ${EndIf}
        ${EndIf}
        SetErrorLevel $R3
        Quit
      ${EndIf}
      nsExec::ExecToStack '"$PLUGINSDIR\DataFusion.ExportPreserver.exe" Backup'
      Pop $R0
      Pop $R1
      ${If} $R0 != 0
        CreateDirectory "$exportBackupPath"
        FileOpen $R2 "$exportBackupPath\installer-backup.log" w
        FileWrite $R2 "exit=$R0$\r$\n$R1$\r$\n"
        FileClose $R2
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONSTOP "导出文件备份未完成，已停止安装，原程序和文件未删除。错误详情：$R1$\r$\n诊断日志及备份位置：$exportBackupPath"
        ${EndIf}
        SetErrorLevel 21
        Quit
      ${EndIf}
    SectionEnd
  !endif
!macroend

!macro customInstall
  nsExec::ExecToStack '"$PLUGINSDIR\DataFusion.ExportPreserver.exe" Restore'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    FileOpen $R2 "$exportBackupPath\installer-restore.log" w
    FileWrite $R2 "exit=$R0$\r$\n$R1$\r$\n"
    FileClose $R2
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "导出文件自动恢复未完成，请保留备份并联系管理员。错误详情：$R1$\r$\n诊断日志及备份位置：$exportBackupPath"
    ${EndIf}
    SetErrorLevel 22
    Quit
  ${EndIf}
  ; Keep the matching compiler installed by the new application payload.
  ; No installer operation writes to or replaces the Windows system directory.
!macroend

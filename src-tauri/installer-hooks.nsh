!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing verified SignalDesk media tools (internet required)..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\runtime\setup-windows.ps1"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Media tool setup failed. Check your internet connection and run runtime\setup-windows.ps1 from the installed folder to retry. Details: $1" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

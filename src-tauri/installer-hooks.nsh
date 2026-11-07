!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing verified SignalDesk media tools (internet required)..."
  SetDetailsView show
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\runtime\setup-windows.ps1"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Media tool setup failed. Check your internet connection and run runtime\setup-windows.ps1 from the installed folder to retry. See the last download or verification message in Show details." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

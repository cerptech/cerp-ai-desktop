!macro customInstall
  DetailPrint "Register cerp-ai:// protocol handler"
  DeleteRegKey HKCU "Software\Classes\cerp-ai"
  WriteRegStr HKCU "Software\Classes\cerp-ai" "" "URL:CERP AI Protocol"
  WriteRegStr HKCU "Software\Classes\cerp-ai" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cerp-ai\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\cerp-ai\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DetailPrint "Unregister cerp-ai:// protocol handler"
  DeleteRegKey HKCU "Software\Classes\cerp-ai"
!macroend

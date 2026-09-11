; Tauri CLI 2.11.4's embedded APP_ASSOCIATE template leaves the executable
; unquoted. Preserve the installer's association lifecycle and correct only
; our ProgID command/icon after it has written them. No UserChoice changes.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Markwrite.Markdown\shell\open\command" "" `"$INSTDIR\${MAINBINARYNAME}.exe" "%1"`
  WriteRegStr SHCTX "Software\Classes\Markwrite.Markdown\DefaultIcon" "" `"$INSTDIR\${MAINBINARYNAME}.exe",0`
  !insertmacro UPDATEFILEASSOC
!macroend

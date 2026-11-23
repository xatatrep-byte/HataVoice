; The installer of ХатаВойс. Started by hand it is a wizard: where to put the program (the folder it is in now, if it is
; installed), which shortcuts, then the bar, then «Готово» with «Запустить». Started by the program itself to update
; (`/UPDATE`) or silently (`/S`) it asks nothing. Either way it closes the running program with its server and LiveKit
; (a file in use cannot be replaced), puts the new files over the old ones and keeps all the data, which lives apart from
; the program's folder.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
SetCompressor /SOLID "{{compression}}"

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WinMessages.nsh
!include LogicLib.nsh
!include "utils.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include nsDialogs.nsh

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define INSTALLMODE "{{install_mode}}"
!define INSTALLERICON "{{installer_icon}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define TITLE "ХатаВойс"
; Where the installer leaves a copy of itself: the server hands it to its members.
!define UPDATEDIR "update"
!define UPDATEFILE "HataVoice-setup.exe"

!define BG "0x14110E"
!define FG "0xEFEAE1"
!define DIM "0x9A9184"
; The folder field: a step lighter than the page.
!define FIELD "0x221E19"

Name "${TITLE}"
Caption "${TITLE} ${VERSION}"
BrandingText " "
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\${PRODUCTNAME}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
RequestExecutionLevel user

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${TITLE}"
VIAddVersionKey "LegalCopyright" "${TITLE}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!addplugindir "${ADDITIONALPLUGINSPATH}"

!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
  !define MUI_UNICON "${INSTALLERICON}"
!endif
!define MUI_ABORTWARNING

Var FirstInstall
; Started by the program to update, or silently: no questions.
Var Updating
; What is installed now: its folder and version (empty when nothing is).
Var OldDir
Var OldVersion
Var DirField
Var DesktopBox
Var StartBox
Var RunBox
Var WantDesktop
Var WantStart
Var WantRun

; Dark like the program, so that a double click does not flash white at the owner at night.
Page custom OptionsPage OptionsLeave
!define MUI_PAGE_HEADER_TEXT "Ставлю ${TITLE} ${VERSION}"
!define MUI_PAGE_HEADER_SUBTEXT "Настройки, ключи и переписка останутся на месте"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW DarkPage
!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPage FinishLeave

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.DarkPage
!define MUI_PAGE_HEADER_TEXT "Удаляю ${TITLE}"
!define MUI_PAGE_HEADER_SUBTEXT "Твои настройки и ключи останутся на этом ПК"
!insertmacro MUI_UNPAGE_INSTFILES

{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
{{#each language_files}}
  !include "{{this}}"
{{/each}}

!macro Paint parent id foreground
  GetDlgItem $1 ${parent} ${id}
  SetCtlColors $1 ${foreground} ${BG}
!macroend

!macro DarkWindow
  SetCtlColors $HWNDPARENT ${FG} ${BG}
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${FG} ${BG}
  !insertmacro Paint $HWNDPARENT 1037 ${FG}
  !insertmacro Paint $HWNDPARENT 1038 ${DIM}
  !insertmacro Paint $HWNDPARENT 1034 ${FG}
  !insertmacro Paint $HWNDPARENT 1256 ${DIM}
  !insertmacro Paint $HWNDPARENT 1028 ${DIM}
  !insertmacro Paint $0 1006 ${DIM}
  ; The bar in the program's color: without the visual style Windows lets one choose it.
  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
  SendMessage $1 ${PBM_SETBARCOLOR} 0 0x3CA8F0
  SendMessage $1 ${PBM_SETBKCOLOR} 0 0x2A241E
!macroend

Function DarkPage
  !insertmacro DarkWindow
FunctionEnd

Function un.DarkPage
  !insertmacro DarkWindow
FunctionEnd

; A checkbox Windows lets color: without its visual style.
!macro DarkCheck hwnd
  System::Call 'uxtheme::SetWindowTheme(p ${hwnd}, w "", w "")'
  SetCtlColors ${hwnd} ${FG} ${BG}
!macroend

; The first page of a wizard: where, which shortcuts, and what happens to an installed version.
Function OptionsPage
  ${If} $Updating = 1
    Abort
  ${EndIf}
  ${If} $OldVersion != ""
    !insertmacro MUI_HEADER_TEXT "Обновление ${TITLE}" "Сейчас стоит $OldVersion — поставлю ${VERSION}. Настройки, ключи и переписка останутся"
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Установка ${TITLE} ${VERSION}" "Выбери папку и ярлыки, потом нажми «Установить»"
  ${EndIf}
  !insertmacro DarkWindow
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  SetCtlColors $0 ${FG} ${BG}

  ${NSD_CreateLabel} 0 0 100% 10u "Папка программы"
  Pop $1
  SetCtlColors $1 ${FG} ${BG}
  ${NSD_CreateText} 0 13u 76% 13u "$INSTDIR"
  Pop $DirField
  SetCtlColors $DirField ${FG} ${FIELD}
  ${NSD_CreateBrowseButton} 78% 12u 22% 15u "Обзор…"
  Pop $1
  ${NSD_OnClick} $1 BrowseDir
  ${NSD_CreateLabel} 0 31u 100% 30u "Права администратора не нужны: программа ставится только для тебя. Настройки, ключи и переписка лежат отдельно, в папке пользователя, и при смене папки никуда не денутся."
  Pop $1
  SetCtlColors $1 ${DIM} ${BG}

  ${NSD_CreateCheckbox} 0 66u 100% 12u "Ярлык на рабочем столе"
  Pop $DesktopBox
  !insertmacro DarkCheck $DesktopBox
  ${If} $FirstInstall = 1
  ${OrIf} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    ${NSD_Check} $DesktopBox
  ${EndIf}
  ${NSD_CreateCheckbox} 0 81u 100% 12u "Ярлык в меню «Пуск»"
  Pop $StartBox
  !insertmacro DarkCheck $StartBox
  ${If} $FirstInstall = 1
  ${OrIf} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${NSD_Check} $StartBox
  ${EndIf}

  ${If} $OldVersion != ""
    ${NSD_CreateLabel} 0 102u 100% 24u "Если выбрать другую папку, ${TITLE} переедет туда: файлы из старой папки удалятся, данные останутся."
    Pop $1
    SetCtlColors $1 ${DIM} ${BG}
  ${EndIf}

  GetDlgItem $1 $HWNDPARENT 1
  ${If} $OldVersion != ""
    SendMessage $1 ${WM_SETTEXT} 0 "STR:Обновить"
  ${Else}
    SendMessage $1 ${WM_SETTEXT} 0 "STR:Установить"
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function BrowseDir
  ${NSD_GetText} $DirField $0
  nsDialogs::SelectFolderDialog "Куда поставить ${TITLE}" "$0"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $DirField "$0"
  ${EndIf}
FunctionEnd

Function OptionsLeave
  ${NSD_GetText} $DirField $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "Укажи папку для программы."
    Abort
  ${EndIf}
  ; A folder of other things («D:\Games») gets a folder of ours inside, not our files strewn among its own.
  ${GetFileName} "$0" $1
  ${If} $1 != "${PRODUCTNAME}"
  ${AndIfNot} ${FileExists} "$0\${MAINBINARYNAME}.exe"
    StrCpy $4 0
    FindFirst $2 $3 "$0\*.*"
    ${DoWhile} $3 != ""
      ${If} $3 != "."
      ${AndIf} $3 != ".."
        StrCpy $4 1
        ${Break}
      ${EndIf}
      FindNext $2 $3
    ${Loop}
    FindClose $2
    ${If} $4 = 1
      StrCpy $0 "$0\${PRODUCTNAME}"
    ${EndIf}
  ${EndIf}
  ; The program goes in for this user alone: a folder it may not write to (Program Files) is said at once.
  ClearErrors
  CreateDirectory "$0"
  FileOpen $2 "$0\.hatavoice-write-test" w
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION "В папку «$0» нельзя писать без прав администратора.$\r$\nВыбери папку в своём профиле (например, $LOCALAPPDATA\${PRODUCTNAME}) или на другом диске."
    Abort
  ${EndIf}
  FileClose $2
  Delete "$0\.hatavoice-write-test"
  StrCpy $INSTDIR "$0"
  ${NSD_GetState} $DesktopBox $WantDesktop
  ${NSD_GetState} $StartBox $WantStart
FunctionEnd

; The last page of a wizard: done, and whether to open the program.
Function FinishPage
  ${If} $Updating = 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Готово" "${TITLE} ${VERSION} установлен"
  !insertmacro DarkWindow
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  SetCtlColors $0 ${FG} ${BG}
  ${NSD_CreateLabel} 0 0 100% 24u "${TITLE} стоит в папке $INSTDIR."
  Pop $1
  SetCtlColors $1 ${FG} ${BG}
  ${NSD_CreateCheckbox} 0 30u 100% 12u "Запустить ${TITLE}"
  Pop $RunBox
  !insertmacro DarkCheck $RunBox
  ${NSD_Check} $RunBox
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Готово"
  GetDlgItem $1 $HWNDPARENT 3
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 2
  EnableWindow $1 0
  nsDialogs::Show
FunctionEnd

Function FinishLeave
  ${NSD_GetState} $RunBox $WantRun
FunctionEnd

; Asks the window to close: the program stops its server itself and closes the router ports. What stays gets killed.
!macro CloseEverything un
  FindWindow $0 "" "${TITLE}"
  ${If} $0 <> 0
    SendMessage $0 ${WM_CLOSE} 0 0 /TIMEOUT=2000
  ${EndIf}
  StrCpy $2 0
  ${Do}
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 <> 0
      ${Break}
    ${EndIf}
    Sleep 250
    IntOp $2 $2 + 1
  ${LoopWhile} $2 < 32
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "hatavoice-server.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "livekit-server.exe"
  Pop $0
!macroend

; Windows lets go of a killed program's files a moment later.
!macro WaitForFile file
  StrCpy $2 0
  ${Do}
    ${IfNot} ${FileExists} "${file}"
      ${Break}
    ${EndIf}
    ClearErrors
    FileOpen $0 "${file}" a
    ${IfNot} ${Errors}
      FileClose $0
      ${Break}
    ${EndIf}
    Sleep 250
    IntOp $2 $2 + 1
  ${LoopWhile} $2 < 40
!macroend

Function .onInit
  !insertmacro SetContext
  StrCpy $Updating 0
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    StrCpy $Updating 1
  ${EndIf}
  IfSilent 0 +2
    StrCpy $Updating 1
  StrCpy $OldDir ""
  StrCpy $OldVersion ""
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $4 != ""
    StrCpy $INSTDIR $4
    StrCpy $OldDir $4
  ${EndIf}
  ReadRegStr $4 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $4 == ""
    StrCpy $FirstInstall 1
  ${Else}
    StrCpy $FirstInstall 0
    ReadRegStr $OldVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  StrCpy $WantDesktop ${BST_CHECKED}
  StrCpy $WantStart ${BST_CHECKED}
  StrCpy $WantRun ${BST_CHECKED}
FunctionEnd

Section WebView2
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    SetDetailsPrint both
    DetailPrint "Скачиваю компонент окна Microsoft WebView2…"
    SetDetailsPrint none
    Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    NSISdl::download /NOIEPROXY "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    Pop $0
    ${If} $0 != "success"
      Abort "Нет интернета, чтобы скачать Microsoft WebView2: подключись и запусти установщик снова"
    ${EndIf}
    ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
    ${If} $1 <> 0
      Abort "Microsoft WebView2 не установился"
    ${EndIf}
  ${EndIf}
SectionEnd

Section Install
  SetDetailsPrint textonly
  DetailPrint "Закрываю ${TITLE}…"
  SetDetailsPrint none
  !insertmacro CloseEverything ""
  !insertmacro WaitForFile "$INSTDIR\${MAINBINARYNAME}.exe"
  {{#each binaries}}
    !insertmacro WaitForFile "$INSTDIR\\{{this}}"
  {{/each}}

  ; Moved to another folder: the old one goes, by its own uninstaller (it keeps the data, as always), before this one
  ; writes where the program is.
  ${If} $OldDir != ""
  ${AndIf} $OldDir != $INSTDIR
  ${AndIf} ${FileExists} "$OldDir\uninstall.exe"
    SetDetailsPrint textonly
    DetailPrint "Убираю старую папку…"
    SetDetailsPrint none
    ExecWait '"$OldDir\uninstall.exe" /S _?=$OldDir'
    Delete "$OldDir\uninstall.exe"
    RMDir "$OldDir"
    StrCpy $FirstInstall 1
  ${EndIf}

  SetDetailsPrint textonly
  DetailPrint "Копирую файлы…"
  SetDetailsPrint none
  SetOutPath $INSTDIR
  File "${MAINBINARYSRCPATH}"
  ; The shortcuts' picture is a file of its own named after the version: Windows caches the picture of a path and kept
  ; showing the old house for the program's exe after an update, told or not; a new path it reads from the disk.
  Delete "$INSTDIR\hatavoice-*.ico"
  File "/oname=hatavoice-${VERSION}.ico" "${INSTALLERICON}"
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${TITLE}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${TITLE}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"
  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  ; The wizard does what was ticked. An update by the program keeps what the person did with the shortcuts, also the pin
  ; on the taskbar: shortcuts are made only for a first install.
  ${If} $Updating = 0
    ${If} $WantStart == ${BST_CHECKED}
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\hatavoice-${VERSION}.ico" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${Else}
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} $WantDesktop == ${BST_CHECKED}
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\hatavoice-${VERSION}.ico" 0
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${Else}
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${ElseIf} $FirstInstall = 0
    ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\hatavoice-${VERSION}.ico" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\hatavoice-${VERSION}.ico" 0
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${ElseIf} $FirstInstall = 1
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\hatavoice-${VERSION}.ico" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\hatavoice-${VERSION}.ico" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; A new version may bring a new icon, but Windows keeps the old picture for the program's path in its cache and the
  ; shortcuts go on showing it (the owner's desktop kept the old house after 0.17.0's new icon). Tell the shell that the
  ; program and its shortcuts changed (SHCNE_UPDATEITEM, a path, flushed), have it rebuild the icon cache, and say that
  ; the icons changed (SHCNE_ASSOCCHANGED). ie4uinit is 64-bit only, out of reach of a 32-bit installer's redirection.
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$SMPROGRAMS\${PRODUCTNAME}.lnk", p 0)'
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec '"$WINDIR\System32\ie4uinit.exe" -show'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'

  ; For friends: the server hands this very file to its members, and each checks the publisher's signature in it.
  ${If} "$EXEPATH" != "$INSTDIR\${UPDATEDIR}\${UPDATEFILE}"
    CreateDirectory "$INSTDIR\${UPDATEDIR}"
    CopyFiles /SILENT "$EXEPATH" "$INSTDIR\${UPDATEDIR}\${UPDATEFILE}"
  ${EndIf}
SectionEnd

; After the last page: an update opens the program again (unless /NORUN), the wizard as «Запустить» says.
Function .onInstSuccess
  ${GetOptions} $CMDLINE "/NORUN" $0
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ${If} $Updating = 1
  ${OrIf} $WantRun == ${BST_CHECKED}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext
  MessageBox MB_YESNO|MB_ICONQUESTION "Удалить ${TITLE}? Настройки и ключи останутся на этом ПК." /SD IDYES IDYES +2
  Abort
FunctionEnd

Section Uninstall
  !insertmacro CloseEverything "un."
  !insertmacro WaitForFile "$INSTDIR\${MAINBINARYNAME}.exe"
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}
  Delete "$INSTDIR\${UPDATEDIR}\${UPDATEFILE}"
  RMDir "$INSTDIR\${UPDATEDIR}"
  Delete "$INSTDIR\hatavoice-*.ico"
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}
  Delete "$INSTDIR\uninstall.exe"
  {{#each resources_ancestors}}
    RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"
  !insertmacro DeleteAppUserModelId
  !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty HKCU "${MANUKEY}"
SectionEnd

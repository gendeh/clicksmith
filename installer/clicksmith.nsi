!include "MUI.nsh"

Name "Clicksmith"
OutFile "ClicksmithInstaller.exe"
InstallDir "$LOCALAPPDATA\Clicksmith"
RequestExecutionLevel user

!define MUI_ICON "..\client\public\icon.ico"
!define MUI_UNICON "..\client\public\icon.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "eula.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  
  ; Copy release files from client build
  File /r "..\client\release\win-unpacked\*.*"
  
  ; Create shortcut
  CreateShortCut "$DESKTOP\Clicksmith.lnk" "$INSTDIR\Clicksmith.exe"
  
  ; Write uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  
  ; Register application
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clicksmith" "DisplayName" "Clicksmith"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clicksmith" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clicksmith" "DisplayIcon" "$INSTDIR\Clicksmith.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clicksmith" "Publisher" "Clicksmith Team"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Clicksmith.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clicksmith"
SectionEnd

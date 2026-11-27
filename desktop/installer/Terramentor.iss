; The Windows installer: the same app folder the zip holds, installed for the
; current user only. Compiled by tools/build-installer.mjs with Inno Setup 6.7
; (ISCC), which passes the defines below; tools/installer-gates.mjs reads this
; file and holds it to what it promises.
;
; What it does, and why each part is the way it is:
;
;   * Per user, never elevated (PrivilegesRequired=lowest). The app goes in
;     %LOCALAPPDATA%\Programs\Terramentor, which its owner can write, so the
;     one-click updater (desktop/updater.js) keeps replacing it in place.
;   * Its own files (the uninstaller and its log) go in {app}\uninstall. A
;     one-click update moves only the names its release's file list holds,
;     and desktop/updateCore.js NEVER_MOVED keeps that folder out of any list.
;   * `.studyvault` files open in the app: per-user keys under
;     HKCU\Software\Classes, a ProgID whose command is
;     `Terramentor.exe --open "%1"` (desktop/wrappers/Launcher.cs passes the
;     file on; nothing is imported without the learner's press).
;   * The library is not the app. It lives in %LOCALAPPDATA%\Terramentor (or
;     where the learner moved it), outside {app}, and nothing here reads,
;     moves or deletes it. A `data` folder or `library-location.txt` inside
;     {app} (a library kept beside the app) is left where it is, too.
;   * An older setup never runs over a newer copy: a library a newer version
;     has migrated is not one an older version may open.

#define AppName "Terramentor"
#define AppExe "Terramentor.exe"
; desktop/lib.js SETUP_DIR and SETUP_APP_ID; Launcher.cs makes the mutex.
#define SetupDir "uninstall"
#define AppIdGuid "FAB61417-9642-4E5C-81D3-61B06762DEB7"
#define RunningMutex "Terramentor.running"
#define ProgId "Terramentor.StudyVault"

#ifndef AppVersion
  #error Pass /DAppVersion=<version> (tools/build-installer.mjs does)
#endif
#ifndef NumericVersion
  #error Pass /DNumericVersion=<a.b.c.d>
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<the built app folder>
#endif
#ifndef ArtDir
  #error Pass /DArtDir=<the folder holding the wizard images>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef OutputBase
  #define OutputBase AppName + "-" + AppVersion + "-win32-x64-setup"
#endif
#ifndef Compression
  #define Compression "lzma2/max"
#endif

[Setup]
AppId={{{#AppIdGuid}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
AppPublisherURL=https://github.com/ValeraZSD/terramentor
AppSupportURL=https://github.com/ValeraZSD/terramentor/issues
AppUpdatesURL=https://github.com/ValeraZSD/terramentor/releases
VersionInfoVersion={#NumericVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
PrivilegesRequired=lowest
DefaultDirName={userpf}\{#AppName}
UsePreviousAppDir=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=yes
UninstallFilesDir={app}\{#SetupDir}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppName}.ico
SetupIconFile={#SourceDir}\{#AppName}.ico
AppMutex={#RunningMutex}
ChangesAssociations=yes
WizardStyle=modern dynamic
WizardImageFile={#ArtDir}\wizard-100.png,{#ArtDir}\wizard-125.png,{#ArtDir}\wizard-150.png,{#ArtDir}\wizard-200.png
WizardSmallImageFile={#ArtDir}\small-100.png,{#ArtDir}\small-125.png,{#ArtDir}\small-150.png,{#ArtDir}\small-200.png
; The same pictures when Windows is dark: left blank, the dark wizard shows
; Inno Setup's own. Identical files are stored once.
WizardImageFileDynamicDark={#ArtDir}\wizard-100.png,{#ArtDir}\wizard-125.png,{#ArtDir}\wizard-150.png,{#ArtDir}\wizard-200.png
WizardSmallImageFileDynamicDark={#ArtDir}\small-100.png,{#ArtDir}\small-125.png,{#ArtDir}\small-150.png,{#ArtDir}\small-200.png
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression={#Compression}
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
ShowLanguageDialog=no

; The interface languages the app ships, where Inno Setup has a translation.
#define Has(File) FileExists(CompilerPath + "Languages\" + File + ".isl")
#define Lang(Code, File) Has(File) ? "Name: " + Code + "; MessagesFile: compiler:Languages\" + File + ".isl" : ""
[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
#emit Lang("ar", "Arabic")
#emit Lang("de", "German")
#emit Lang("es", "Spanish")
#emit Lang("fr", "French")
#emit Lang("it", "Italian")
#emit Lang("ja", "Japanese")
#emit Lang("nl", "Dutch")
#emit Lang("pl", "Polish")
#emit Lang("pt", "Portuguese")
#emit Lang("ptbr", "BrazilianPortuguese")
#emit Lang("ru", "Russian")
#emit Lang("tr", "Turkish")
#emit Lang("uk", "Ukrainian")
#emit Lang("zh", "ChineseSimplified")

#define Msg(Code, File, Key, Text) Has(File) ? Code + "." + Key + "=" + Text : ""
[Messages]
; The uninstaller's question says what stays: the library is left alone where
; the app puts it (the per-user folder, or the kept `data` folder of a portable
; copy). One a person moved into the app folder under another name would go.
ConfirmUninstall=Remove %1 from this computer? Your courses and progress stay in your library folder.
#emit Msg("ar", "Arabic", "ConfirmUninstall", "هل تريد إزالة %1 من هذا الكمبيوتر؟ تبقى دوراتك وتقدّمك في مجلد مكتبتك.")
#emit Msg("de", "German", "ConfirmUninstall", "%1 von diesem Computer entfernen? Deine Kurse und dein Fortschritt bleiben in deinem Bibliotheksordner.")
#emit Msg("es", "Spanish", "ConfirmUninstall", "¿Quitar %1 de este equipo? Tus cursos y tu progreso se quedan en la carpeta de tu biblioteca.")
#emit Msg("fr", "French", "ConfirmUninstall", "Supprimer %1 de cet ordinateur ? Vos cours et votre progression restent dans le dossier de votre bibliothèque.")
#emit Msg("it", "Italian", "ConfirmUninstall", "Rimuovere %1 da questo computer? I tuoi corsi e i tuoi progressi restano nella cartella della libreria.")
#emit Msg("ja", "Japanese", "ConfirmUninstall", "このコンピューターから %1 を削除しますか？コースと学習の進み具合はライブラリのフォルダーに残ります。")
#emit Msg("nl", "Dutch", "ConfirmUninstall", "%1 van deze computer verwijderen? Je cursussen en voortgang blijven in je bibliotheekmap staan.")
#emit Msg("pl", "Polish", "ConfirmUninstall", "Usunąć %1 z tego komputera? Twoje kursy i postępy pozostaną w folderze biblioteki.")
#emit Msg("pt", "Portuguese", "ConfirmUninstall", "Remover o %1 deste computador? Os seus cursos e o seu progresso ficam na pasta da biblioteca.")
#emit Msg("ptbr", "BrazilianPortuguese", "ConfirmUninstall", "Remover o %1 deste computador? Seus cursos e seu progresso ficam na pasta da biblioteca.")
#emit Msg("ru", "Russian", "ConfirmUninstall", "Удалить %1 с этого компьютера? Ваши курсы и прогресс останутся в папке библиотеки.")
#emit Msg("tr", "Turkish", "ConfirmUninstall", "%1 bu bilgisayardan kaldırılsın mı? Kurslarınız ve ilerlemeniz kitaplık klasörünüzde kalır.")
#emit Msg("uk", "Ukrainian", "ConfirmUninstall", "Видалити %1 з цього комп'ютера? Ваші курси та прогрес залишаться в теці бібліотеки.")
#emit Msg("zh", "ChineseSimplified", "ConfirmUninstall", "要从这台电脑上删除 %1 吗？你的课程和学习进度会保留在资料库文件夹中。")

[CustomMessages]
FileTypeName=Terramentor course
NewerInstalled=Terramentor %1 is already installed, and this setup holds an older version (%2). An older version may not open a library the newer one has already updated, so nothing was changed.
#emit Msg("ar", "Arabic", "FileTypeName", "دورة Terramentor")
#emit Msg("ar", "Arabic", "NewerInstalled", "Terramentor %1 مثبّت بالفعل، وهذا المثبّت يحتوي على إصدار أقدم (%2). قد لا يفتح الإصدار الأقدم مكتبة حدّثها الإصدار الأحدث بالفعل، لذلك لم يتغيّر شيء.")
#emit Msg("de", "German", "FileTypeName", "Terramentor-Kurs")
#emit Msg("de", "German", "NewerInstalled", "Terramentor %1 ist bereits installiert, und dieses Setup enthält eine ältere Version (%2). Eine ältere Version kann eine Bibliothek, die die neuere schon aktualisiert hat, womöglich nicht öffnen. Es wurde nichts geändert.")
#emit Msg("es", "Spanish", "FileTypeName", "Curso de Terramentor")
#emit Msg("es", "Spanish", "NewerInstalled", "Terramentor %1 ya está instalado y este instalador contiene una versión anterior (%2). Una versión anterior quizá no pueda abrir una biblioteca que la más reciente ya actualizó, así que no se ha cambiado nada.")
#emit Msg("fr", "French", "FileTypeName", "Cours Terramentor")
#emit Msg("fr", "French", "NewerInstalled", "Terramentor %1 est déjà installé, et ce programme d'installation contient une version plus ancienne (%2). Une version plus ancienne risque de ne pas ouvrir une bibliothèque déjà mise à jour par la plus récente : rien n'a été modifié.")
#emit Msg("it", "Italian", "FileTypeName", "Corso Terramentor")
#emit Msg("it", "Italian", "NewerInstalled", "Terramentor %1 è già installato e questo programma di installazione contiene una versione precedente (%2). Una versione precedente potrebbe non aprire una libreria già aggiornata da quella più recente, quindi non è stato modificato nulla.")
#emit Msg("ja", "Japanese", "FileTypeName", "Terramentor コース")
#emit Msg("ja", "Japanese", "NewerInstalled", "Terramentor %1 はすでにインストールされており、このセットアップには古いバージョン (%2) が入っています。古いバージョンでは、新しいバージョンが更新したライブラリを開けないことがあるため、何も変更していません。")
#emit Msg("nl", "Dutch", "FileTypeName", "Terramentor-cursus")
#emit Msg("nl", "Dutch", "NewerInstalled", "Terramentor %1 is al geïnstalleerd en deze installatie bevat een oudere versie (%2). Een oudere versie kan een bibliotheek die de nieuwere al heeft bijgewerkt mogelijk niet openen, dus er is niets gewijzigd.")
#emit Msg("pl", "Polish", "FileTypeName", "Kurs Terramentor")
#emit Msg("pl", "Polish", "NewerInstalled", "Terramentor %1 jest już zainstalowany, a ten instalator zawiera starszą wersję (%2). Starsza wersja może nie otworzyć biblioteki, którą nowsza już zaktualizowała, dlatego nic nie zostało zmienione.")
#emit Msg("pt", "Portuguese", "FileTypeName", "Curso do Terramentor")
#emit Msg("pt", "Portuguese", "NewerInstalled", "O Terramentor %1 já está instalado e este instalador contém uma versão mais antiga (%2). Uma versão mais antiga pode não abrir uma biblioteca que a mais recente já atualizou, por isso nada foi alterado.")
#emit Msg("ptbr", "BrazilianPortuguese", "FileTypeName", "Curso do Terramentor")
#emit Msg("ptbr", "BrazilianPortuguese", "NewerInstalled", "O Terramentor %1 já está instalado e este instalador contém uma versão mais antiga (%2). Uma versão mais antiga pode não abrir uma biblioteca que a mais recente já atualizou, por isso nada foi alterado.")
#emit Msg("ru", "Russian", "FileTypeName", "Курс Terramentor")
#emit Msg("ru", "Russian", "NewerInstalled", "Terramentor %1 уже установлен, а этот установщик содержит более старую версию (%2). Старая версия может не открыть библиотеку, которую новая уже обновила, поэтому ничего не изменено.")
#emit Msg("tr", "Turkish", "FileTypeName", "Terramentor kursu")
#emit Msg("tr", "Turkish", "NewerInstalled", "Terramentor %1 zaten yüklü ve bu kurulum daha eski bir sürüm (%2) içeriyor. Daha eski bir sürüm, yenisinin zaten güncellediği bir kitaplığı açamayabilir; bu yüzden hiçbir şey değiştirilmedi.")
#emit Msg("uk", "Ukrainian", "FileTypeName", "Курс Terramentor")
#emit Msg("uk", "Ukrainian", "NewerInstalled", "Terramentor %1 уже встановлено, а цей інсталятор містить старішу версію (%2). Старіша версія може не відкрити бібліотеку, яку новіша вже оновила, тому нічого не змінено.")
#emit Msg("zh", "ChineseSimplified", "FileTypeName", "Terramentor 课程")
#emit Msg("zh", "ChineseSimplified", "NewerInstalled", "已安装 Terramentor %1，而此安装程序包含较旧的版本 (%2)。较旧的版本可能无法打开新版本已更新的资料库，因此未做任何更改。")

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppName}.ico"; Comment: "Local-first mastery engine for self-directed learners"

; Per-user file type. The extension's default names the ProgID, and
; OpenWithProgids lists it so another app's later claim does not hide it from
; "Open with". Every key or value written here is removed on uninstall.
[Registry]
Root: HKCU; Subkey: "Software\Classes\.studyvault"; ValueType: string; ValueName: ""; ValueData: "{#ProgId}"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Classes\.studyvault\OpenWithProgids"; ValueType: string; ValueName: "{#ProgId}"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Classes\{#ProgId}"; ValueType: string; ValueName: ""; ValueData: "{cm:FileTypeName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#ProgId}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppName}.ico"
Root: HKCU; Subkey: "Software\Classes\{#ProgId}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" --open ""%1"""

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppIdGuid}}_is1';

{ The next dot-separated field of S, taken off its front. }
function NextField(var S: String): String;
var
  P: Integer;
begin
  P := Pos('.', S);
  if P = 0 then
  begin
    Result := S;
    S := '';
  end else
  begin
    Result := Copy(S, 1, P - 1);
    S := Copy(S, P + 1, Length(S));
  end;
end;

function IsNumber(const S: String): Boolean;
var
  I: Integer;
begin
  Result := Length(S) > 0;
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
    begin
      Result := False;
      Exit;
    end;
end;

{ Above zero when A is the newer version: server/version.js compareVersions,
  the rule the app itself updates by. Numbers compare as numbers, a
  prerelease (1.7.0-nightly.20261127.2) loses to its release, and prerelease
  fields compare one at a time, numbers below words. }
function CompareVersions(A, B: String): Integer;
var
  PreA, PreB, X, Y: String;
  I, P: Integer;
begin
  Result := 0;
  PreA := '';
  PreB := '';
  P := Pos('-', A);
  if P > 0 then
  begin
    PreA := Copy(A, P + 1, Length(A));
    A := Copy(A, 1, P - 1);
  end;
  P := Pos('-', B);
  if P > 0 then
  begin
    PreB := Copy(B, P + 1, Length(B));
    B := Copy(B, 1, P - 1);
  end;
  for I := 1 to 3 do
  begin
    Result := StrToIntDef(NextField(A), 0) - StrToIntDef(NextField(B), 0);
    if Result <> 0 then Exit;
  end;
  if (PreA = '') and (PreB = '') then Exit;
  if PreA = '' then begin Result := 1; Exit; end;
  if PreB = '' then begin Result := -1; Exit; end;
  while (PreA <> '') or (PreB <> '') do
  begin
    if PreA = '' then begin Result := -1; Exit; end;
    if PreB = '' then begin Result := 1; Exit; end;
    X := NextField(PreA);
    Y := NextField(PreB);
    if X <> Y then
    begin
      if IsNumber(X) and IsNumber(Y) then Result := StrToIntDef(X, 0) - StrToIntDef(Y, 0)
      else if IsNumber(X) then Result := -1
      else if IsNumber(Y) then Result := 1
      else if X < Y then Result := -1
      else Result := 1;
      if Result <> 0 then Exit;
    end;
  end;
end;

{ The version of the copy in Dir, from its package.json ('' when unknown). A
  one-click update changes it without this installer, so the folder is the
  truth, not the version this installer once wrote. }
function VersionIn(const Dir: String): String;
var
  Raw: AnsiString;
  S: String;
  P: Integer;
begin
  Result := '';
  if not LoadStringFromFile(AddBackslash(Dir) + 'package.json', Raw) then Exit;
  S := String(Raw);
  P := Pos('"version"', S);
  if P = 0 then Exit;
  S := Copy(S, P + 9, 200);
  P := Pos('"', S);
  if P = 0 then Exit;
  S := Copy(S, P + 1, 100);
  P := Pos('"', S);
  if P = 0 then Exit;
  Result := Copy(S, 1, P - 1);
end;

function InitializeSetup(): Boolean;
var
  Dir, Installed: String;
begin
  Result := True;
  if not RegQueryStringValue(HKCU, UninstallKey, 'Inno Setup: App Path', Dir) then Exit;
  Installed := VersionIn(Dir);
  if (Installed <> '') and (CompareVersions(Installed, '{#AppVersion}') > 0) then
  begin
    SuppressibleMsgBox(FmtMessage(CustomMessage('NewerInstalled'), [Installed, '{#AppVersion}']), mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

{ Names in the app folder that are not the app's: a library kept beside it,
  the pointer to one, and this installer's own folder. }
function KeptInAppFolder(const Name: String): Boolean;
begin
  Result := (CompareText(Name, 'data') = 0) or (CompareText(Name, 'library-location.txt') = 0)
    or (CompareText(Name, '{#SetupDir}') = 0);
end;

{ Every top-level entry of the app folder that belongs to the app goes.
  The files a one-click update brought are not in this installer's log, so
  removing only what it installed would leave a newer version's files
  behind (and, on reinstalling, stale ones beside the new). Run only on a
  folder that holds a packaged Terramentor (its build.json). DelTree removes
  a junction without following it. }
procedure ClearAppFolder(const Dir: String);
var
  Find: TFindRec;
  Path: String;
begin
  if not FileExists(AddBackslash(Dir) + 'build.json') then Exit;
  if not FindFirst(AddBackslash(Dir) + '*', Find) then Exit;
  try
    repeat
      if (Find.Name <> '.') and (Find.Name <> '..') and not KeptInAppFolder(Find.Name) then
      begin
        Path := AddBackslash(Dir) + Find.Name;
        if Find.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then DelTree(Path, True, True, True)
        else DeleteFile(Path);
      end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { Before the files go in: the previous version's files go out, as a
    one-click update would move them, so nothing stale stays beside the new. }
  if CurStep = ssInstall then ClearAppFolder(ExpandConstant('{app}'));
end;

{ Text in a .lnk is UTF-16; this reads the file's bytes as UTF-16 starting at
  byte Offset (0 or 1, since a string need not start on an even byte). }
function Utf16Text(const Raw: AnsiString; Offset: Integer): String;
var
  I: Integer;
begin
  Result := '';
  I := 1 + Offset;
  while I + 1 <= Length(Raw) do
  begin
    Result := Result + Chr(Ord(Raw[I]) + Ord(Raw[I + 1]) * 256);
    I := I + 2;
  end;
end;

{ Whether the shortcut at Path names the app folder anywhere in its text
  (target, working folder, arguments). }
function LinkNamesFolder(const Path, Dir: String): Boolean;
var
  Raw: AnsiString;
  Needle: String;
begin
  Result := False;
  if not LoadStringFromFile(Path, Raw) then Exit;
  Needle := Lowercase(RemoveBackslash(Dir));
  Result := (Pos(Needle, Lowercase(Utf16Text(Raw, 0))) > 0) or (Pos(Needle, Lowercase(Utf16Text(Raw, 1))) > 0);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir, Startup: String;
begin
  { Before the uninstaller works through its log: build.json, the sign that
    this is the app's folder, is one of the files it is about to delete. }
  if CurUninstallStep <> usUninstall then Exit;
  Dir := ExpandConstant('{app}');
  ClearAppFolder(Dir);
  { "Start when I sign in" (server/autostart) writes this shortcut; one that
    starts this copy would fail at every sign-in once the copy is gone. One
    that starts another copy (a zip unpacked elsewhere) stays. }
  Startup := ExpandConstant('{userstartup}\{#AppName}.lnk');
  if FileExists(Startup) and LinkNamesFolder(Startup, Dir) then DeleteFile(Startup);
end;

{ The progress page names each of the app's thousands of files as it copies them,
  internal paths that tell a person nothing; the bar and "Extracting files"
  say enough. }
procedure InitializeWizard;
begin
  WizardForm.FilenameLabel.Visible := False;
end;

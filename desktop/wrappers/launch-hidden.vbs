' Run a command with no window at all.
'
' This exists for ONE case: a source checkout on Windows that has been asked to
' start at sign-in. A packaged copy has Terramentor.exe, which is a windowless
' program with a tray icon and needs none of this. A checkout has only
' `node.exe desktop/launcher.js`, and node.exe is a CONSOLE program — Windows
' gives it a console window whatever a shortcut asks for, and that console is
' not a log viewer that can be closed: it IS the server, so closing it to tidy
' the desktop stops the app. Minimising it (a .lnk window style of 7) only
' moves the problem to the taskbar.
'
' wscript.exe is a GUI-subsystem host, so nothing flashes on the way through,
' and WshShell.Run with a window style of 0 starts the child with no console of
' its own. The launcher writes everything it would have printed to
' logs/app.log in the data directory, so nothing is lost by hiding it.
'
' Every argument is passed on, quoted: the paths involved routinely contain
' spaces, and an unquoted one stops at the first.
'
'   wscript.exe launch-hidden.vbs <program> [argument ...]

Option Explicit

Dim shell, command, i

If WScript.Arguments.Count = 0 Then
    WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")

command = ""
For i = 0 To WScript.Arguments.Count - 1
    If i > 0 Then command = command & " "
    command = command & """" & WScript.Arguments(i) & """"
Next

' 0 = no window, False = do not wait. This script is a doorway, not a parent:
' it returns at once and the app outlives it.
shell.Run command, 0, False

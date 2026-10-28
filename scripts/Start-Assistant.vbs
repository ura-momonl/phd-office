Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powerShellPath & """ -NoProfile -ExecutionPolicy Bypass -File """ & scriptDirectory & "\Start-Assistant.ps1"""
shell.Run command, 0, False

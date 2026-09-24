@echo off
:: Code Crumb launcher for Windows
:: Starts the face renderer and launches Claude Code with all arguments
:: node.exe, not node: cmd.exe looks in the current folder first and tries
:: PATHEXT, so a project file named node.js or node.cmd would run instead.
node.exe "%~dp0launch.js" %*

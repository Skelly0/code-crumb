#!/usr/bin/env bash
# Code Crumb launcher for macOS/Linux
# Starts the face renderer and launches Claude Code with all arguments
# Resolve symlinks first: the README installs this script as a symlink on
# PATH, and dirname of the link is the bin directory, not the repo.
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
node "$SCRIPT_DIR/launch.js" "$@"

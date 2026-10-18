#!/usr/bin/env bash
# Code Crumb launcher for macOS/Linux
# Starts the face renderer and launches Claude Code with all arguments
# Resolve symlinks first: the README installs this script as a symlink on
# PATH, and dirname of the link is the bin directory, not the repo.
# CDPATH= keeps an exported CDPATH from sending a relative `cd` elsewhere,
# and >/dev/null drops the directory cd prints when it uses one.
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" >/dev/null && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" >/dev/null && pwd)"
node "$SCRIPT_DIR/launch.js" "$@"

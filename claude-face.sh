#!/usr/bin/env bash
# Claude Face launcher for macOS/Linux
# Starts the face renderer and launches Claude Code with all arguments
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/launch.js" "$@"

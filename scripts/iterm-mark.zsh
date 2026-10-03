#!/usr/bin/env zsh
# Marks the terminal of the Strato master in iTerm2: amber tab, amber-tinted background, badge.
#
# Usage: iterm-mark.zsh
#
# Called from Claude Code's Bash tool, whose output does not reach iTerm2: it walks up the parent processes to the
# first one with a tty, and writes the OSC sequences straight into it.
#
# Restoring the colours is left to the shell: this script drops an override file in ~/.cache/iterm-marker/. A
# precmd hook that recolours tabs per folder can check for that file, delete it and repaint when the master exits.

emulate -L zsh

local pid=$$ tty=""
while [[ -n "$pid" && "$pid" != 1 ]]; do
  tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
  [[ -n "$tty" && "$tty" != "??" ]] && break
  tty=""
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
[[ -n "$tty" && -w "/dev/$tty" ]] || { print -u2 "iterm-mark: no tty found"; exit 0; }

# Signal amber, chosen to stand out from the colours usually given to project folders.
local r=255 g=176 b=0
# Background: a tint strong enough for the master to stand out among the other tabs of the project.
local blend=28 base_r=18 base_g=18 base_b=24
local fr=$(( (base_r * (100 - blend) + r * blend) / 100 ))
local fg=$(( (base_g * (100 - blend) + g * blend) / 100 ))
local fb=$(( (base_b * (100 - blend) + b * blend) / 100 ))

{
  printf '\e]6;1;bg;red;brightness;%d\a'   $r
  printf '\e]6;1;bg;green;brightness;%d\a' $g
  printf '\e]6;1;bg;blue;brightness;%d\a'  $b
  printf '\e]11;#%02x%02x%02x\a' $fr $fg $fb
  printf '\e]1337;SetBadgeFormat=%s\a' "$(print -rn -- '🗼 STRATO' | base64 | tr -d '\n')"
} > "/dev/$tty"

mkdir -p "$HOME/.cache/iterm-marker"
touch "$HOME/.cache/iterm-marker/override-$tty"
print "terminal marked ($tty)"

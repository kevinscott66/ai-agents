#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p bin
calendar_cache="${TMPDIR:-/tmp}/agent-calendar-module-cache"
mkdir -p "$calendar_cache"
swiftc -module-cache-path "$calendar_cache" calendar.swift -o bin/agent-calendar -framework EventKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker calendar-info.plist
codesign --force --sign - --identifier tech.dobropalm.agent.calendar bin/agent-calendar
# Прокладка, через которую демон и зовёт помощника: без неё TCC спрашивает разрешение
# у bun и молча отказывает. Подробности — в calendar-spawn.c и calendar-helper.ts.
clang -O2 -Wall -Wextra -o bin/agent-calendar-run calendar-spawn.c
codesign --force --sign - --identifier tech.dobropalm.agent.calendar.run bin/agent-calendar-run

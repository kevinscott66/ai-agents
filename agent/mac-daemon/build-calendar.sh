#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p bin
calendar_cache="${TMPDIR:-/tmp}/agent-calendar-module-cache"
mkdir -p "$calendar_cache"
swiftc -module-cache-path "$calendar_cache" calendar.swift -o bin/agent-calendar -framework EventKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker calendar-info.plist
codesign --force --sign - --identifier tech.dobropalm.agent.calendar bin/agent-calendar

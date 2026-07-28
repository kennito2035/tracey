#!/usr/bin/env bash
exec node "$(dirname "$0")/mock-core.js" "$@"

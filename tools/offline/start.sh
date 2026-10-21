#!/bin/sh
set -eu
offline_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$offline_dir/runtime/node" ]; then
    chmod u+x "$offline_dir/runtime/node"
    exec "$offline_dir/runtime/node" "$offline_dir/server.mjs" "$@"
fi
if command -v node >/dev/null 2>&1; then
    exec node "$offline_dir/server.mjs" "$@"
fi
printf '%s\n' 'Node.js is required for this source package. Use the package with a runtime for your operating system.' >&2
exit 1

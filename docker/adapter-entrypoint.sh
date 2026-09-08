#!/bin/sh
set -eu
# A host administrator may own the mode-600 bind mount. Copy only the
# configured file into this container, then drop privilege before the runtime.
if [ "$(id -u)" = 0 ]; then
  install -d -m 700 -o 1000 -g 1000 /run/plantbot
  install -m 600 -o 1000 -g 1000 "${PB_ADAPTER_CONFIG:-/config/adapter.json}" /run/plantbot/adapter.json
  export PB_ADAPTER_CONFIG=/run/plantbot/adapter.json
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs "$@"
fi
exec "$@"

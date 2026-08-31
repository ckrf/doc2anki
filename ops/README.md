# Laxu Focus background service

`laxu-focus.service` keeps the production server available on port 3000. The
installed user service starts at boot, restarts after unexpected exits, and
does not depend on an open Codex task or terminal.

After changing application source, rebuild the app and restart the service:

```sh
PATH=/home/katriel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH ./node_modules/.bin/vinext build
systemctl --user restart laxu-focus.service
```

Useful diagnostics:

```sh
systemctl --user status laxu-focus.service
journalctl --user -u laxu-focus.service -n 50 --no-pager
```

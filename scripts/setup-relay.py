#!/usr/bin/env python3
"""Generate private LAN relay credentials, without overwriting an existing setup."""
import os
import secrets
from pathlib import Path
p = Path(__file__).resolve().parents[1] / '.env.relay'
try:
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit('Existing .env.relay preserved. Use its RELAY_ADMIN_TOKEN to unlock administration.')
with os.fdopen(fd, 'w') as f:
    f.write('# LAN test only. Keep private; do not commit or publish this file.\n')
    for name in ['RELAY_ADMIN_TOKEN', 'RELAY_HOOK_TOKEN']:
        f.write(f'{name}={secrets.token_hex(32)}\n')
    f.write('RELAY_HTTP_PORT=8088\nRELAY_SRT_PORT=8890\n')
print('Created .env.relay. Copy RELAY_ADMIN_TOKEN locally into the relay dashboard; never share it with broadcasters.')

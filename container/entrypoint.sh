#!/bin/bash
set -e

# --- Privilege drop (gosu pattern) ---
# If running as root (host is root, or no --user passed), fix ownership of
# writable bind-mounts then re-exec as the 'node' user.  This is the same
# pattern used by official postgres, redis, and mysql images.
if [ "$(id -u)" = '0' ]; then
  # Fix ownership of directories the app needs to write to.
  # /workspace/* and /home/node are bind-mounted from the host and may be
  # owned by root when the host process runs as root.
  chown -R node:node /workspace/group /workspace/ipc /home/node 2>/dev/null || true
  chown -R node:node /workspace/global /workspace/extra 2>/dev/null || true
  # Re-exec this script as 'node' — gosu replaces the current process.
  exec gosu node "$0" "$@"
fi

# --- From here on we are running as 'node' (uid 1000) ---

# Configure git/gh to trust the OneCLI MITM CA and use the proxy
if [ -n "$HTTPS_PROXY" ]; then
  git config --global http.proxy "$HTTPS_PROXY"
fi
if [ -f "$NODE_EXTRA_CA_CERTS" ]; then
  CA_BUNDLE=/tmp/combined-ca.pem
  cat /etc/ssl/certs/ca-certificates.crt "$NODE_EXTRA_CA_CERTS" > "$CA_BUNDLE" 2>/dev/null || true
  git config --global http.sslCAInfo "$CA_BUNDLE"
  export GH_CACERT="$CA_BUNDLE"
  export REQUESTS_CA_BUNDLE="$CA_BUNDLE"
fi

# Compile agent-runner TypeScript (source may be customized per-group)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read input from stdin, run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json

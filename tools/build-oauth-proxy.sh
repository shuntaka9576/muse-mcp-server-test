#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir='.local/oauth-proxy-web'
runtime='cpython-3.13.8-linux-aarch64-gnu'
uv python install --install-dir .local/python-dist --no-bin "$runtime"
mkdir -p "$build_dir/dependencies"
uv pip sync --index-url https://pypi.org/simple --python-version 3.13 \
  --python-platform aarch64-manylinux2014 --only-binary :all: \
  --require-hashes --no-compile-bytecode --target "$build_dir/dependencies" \
  apps/oauth-proxy/requirements.txt
python3 -c 'import shutil,sys; shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)' ".local/python-dist/$runtime" "$build_dir/python"
cp apps/oauth-proxy/server.py apps/oauth-proxy/proxy_app.py apps/oauth-proxy/index.mjs "$build_dir/"
python3 tools/package-oauth-proxy.py "$build_dir" .local/oauth-proxy-web.zip

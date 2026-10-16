#!/bin/bash
# Install the pinned Biome binary (JS/CSS formatter and linter) into .tools/.
# A single static binary, so the project still needs no Node or npm.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=2.5.14
SHA256=290c1c85deeaf01310d9187306060b53961574856a7e34f59d9662562e6f19fe  # biome-linux-x64

if [ "$(uname -sm)" != "Linux x86_64" ]; then
    echo "Pinned hash is for linux-x64. Get biome $VERSION for $(uname -sm) from"
    echo "https://github.com/biomejs/biome/releases and put it at .tools/biome."
    exit 2
fi

if [ -x .tools/biome ] && .tools/biome --version | grep -q "$VERSION"; then
    exit 0
fi

mkdir -p .tools
curl -sSfL -o .tools/biome.tmp \
    "https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%40${VERSION}/biome-linux-x64"
echo "$SHA256  .tools/biome.tmp" | sha256sum -c --quiet
chmod +x .tools/biome.tmp
mv .tools/biome.tmp .tools/biome
.tools/biome --version

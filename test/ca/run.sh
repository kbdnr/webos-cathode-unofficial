#!/bin/sh
# Runs the certificate-overlay test in a privileged Alpine container (needs Docker or Podman).
set -eu
cd "$(dirname "$0")/../.."
engine=$(command -v podman || command -v docker) || { echo "need podman or docker" >&2; exit 1; }
exec "$engine" run --rm --privileged \
  -v "$PWD/ca:/app/ca:ro" \
  -v "$PWD/test/fixtures:/fixtures:ro" \
  -v "$PWD/test/ca:/test:ro" \
  docker.io/library/alpine:3.20 sh /test/in-container.sh

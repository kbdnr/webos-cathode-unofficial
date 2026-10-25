#!/bin/sh
# Adds current Mozilla root CAs to a rooted LG webOS TV's certificate stores, so the web engine
# trusts hosts whose roots postdate the firmware (e.g. ok.ru's HARICA root).
#
# The firmware's files are never modified: each store gets a read-only overlayfs mount whose top
# layer holds merged copies. `uninstall` (or deleting the boot hook and rebooting) restores stock.
# Store list and overlay approach follow throwaway96's setup-cert-overlay.sh:
# https://gist.github.com/throwaway96/bb31a17562eec4d8325020dee8c7e6b5
#
# Usage: cathode-ca.sh install | apply | boot | restart-web-engine | status | uninstall
#   install             copy script + bundle to persistent storage, add a Homebrew Channel boot
#                       hook, apply
#   apply               (re)build and mount the overlays
#   boot                apply, then restart WebAppMgr; what the boot hook runs on every startup
#   restart-web-engine  restart WebAppMgr so web apps see the current stores
#   status              show what is installed and mounted
#   uninstall           unmount everything, remove the boot hook and persistent files
#
# WebAppMgr (the web app runtime) reads the CA bundle once at startup, and it starts well before
# Homebrew Channel runs boot hooks, so mounting alone has no effect on web apps until it restarts.
#
# POSIX sh for webOS's busybox. CATHODE_CA_ROOT prefixes every path (used by the tests).

set -u
umask 022

VERSION=1
NAME=cathode-ca
ROOT=${CATHODE_CA_ROOT:-}
HOME_DIR=$ROOT/var/lib/webosbrew/$NAME
HOOK=$ROOT/var/lib/webosbrew/init.d/$NAME
BUNDLE=mozilla-roots.pem
LAYERS=$HOME_DIR/layers

# Stores read by the TV's TLS clients. Missing ones are skipped.
CERT_DIRS="$ROOT/etc/ssl/certs $ROOT/var/palm/jail/com.webos.app.browser/etc/ssl/certs"
SDP_DIR=$ROOT/usr/share/ca-certificates/sdp
NSS_DIR=$ROOT/etc/pki/nssdb
ALL_DIRS="$CERT_DIRS $SDP_DIR $NSS_DIR"

say() { echo "$NAME: $*"; }
die() { say "error: $*" >&2; exit 1; }

layer_for() { echo "$LAYERS/$(echo "$1" | tr -s '/' '_')"; }
source_for() { echo "$NAME$(echo "$1" | tr -s '/' '_')"; }

# The source name of the topmost mount on a directory, if any.
top_mount() { awk -v t="$1" '$2 == t { s = $1 } END { print s }' /proc/mounts; }
is_ours() { [ "$(top_mount "$1")" = "$(source_for "$1")" ]; }

unmount_all() {
  for d in $ALL_DIRS; do
    while is_ours "$d"; do umount "$d" || break; done
  done
}

# Hash of everything the layers are built from, so they're rebuilt only when an input changes
# (new bundle, new script version, or a firmware update touching the stock stores).
fingerprint() {
  {
    echo "$VERSION"
    cat "$HOME_DIR/$BUNDLE"
    for d in $CERT_DIRS; do cat "$d/ca-certificates.crt" "$d/trusted_cas.crt"; done
    cat "$SDP_DIR/sdp-ca.pem"
    cat "$NSS_DIR"/*
  } 2>/dev/null | md5sum | cut -d' ' -f1
}

split_bundle() {
  awk -v out="$2" '
    /-----BEGIN CERTIFICATE-----/ { n++; f = sprintf("%s/root-%03d.pem", out, n); inside = 1 }
    inside { print > f }
    /-----END CERTIFICATE-----/ { if (inside) close(f); inside = 0 }
  ' "$1"
}

# Merge the bundle into an OpenSSL-style directory: bundle files plus hash-named links.
build_cert_layer() {
  target=$1 layer=$2 split=$3
  for f in ca-certificates.crt trusted_cas.crt; do
    [ -f "$target/$f" ] && { cat "$target/$f"; echo; cat "$HOME_DIR/$BUNDLE"; } >"$layer/$f"
  done
  command -v openssl >/dev/null 2>&1 || { say "openssl not found; $target gets bundles only"; return 0; }
  for pem in "$split"/root-*.pem; do
    file=$NAME-${pem##*/}
    cp "$pem" "$layer/$file"
    for opt in -subject_hash -subject_hash_old; do
      h=$(openssl x509 -in "$pem" -noout "$opt" 2>/dev/null) && [ -n "$h" ] || continue
      i=0
      while [ -e "$target/$h.$i" ] || [ -L "$layer/$h.$i" ]; do i=$((i + 1)); done
      ln -s "$file" "$layer/$h.$i"
    done
  done
}

build_sdp_layer() {
  [ -f "$1/sdp-ca.pem" ] || return 1
  { cat "$1/sdp-ca.pem"; echo; cat "$HOME_DIR/$BUNDLE"; } >"$2/sdp-ca.pem"
}

build_nss_layer() {
  target=$1 layer=$2 split=$3
  command -v certutil >/dev/null 2>&1 || { say "certutil not found; skipping $target"; return 1; }
  cp -p "$target"/* "$layer"/ || return 1
  if [ -f "$layer/cert9.db" ]; then db=sql:$layer
  elif [ -f "$layer/cert8.db" ]; then db=dbm:$layer
  else say "no NSS database in $target"; return 1
  fi
  : >"$split/empty-password"
  added=0
  for pem in "$split"/root-*.pem; do
    nick=$NAME-$(basename "$pem" .pem)
    certutil -A -d "$db" -f "$split/empty-password" -t 'C,,' -n "$nick" -a -i "$pem" \
      </dev/null >/dev/null 2>&1 && added=$((added + 1))
  done
  say "added $added roots to NSS database $target"
}

build_layers() {
  rm -rf "$LAYERS"
  split=$LAYERS/.split
  mkdir -p "$split"
  split_bundle "$HOME_DIR/$BUNDLE" "$split"
  say "bundle has $(ls "$split" | wc -l | tr -d ' ') roots"

  for d in $ALL_DIRS; do
    [ -d "$d" ] || continue
    layer=$(layer_for "$d")
    mkdir -p "$layer"
    case $d in
      "$SDP_DIR") build_sdp_layer "$d" "$layer" ;;
      "$NSS_DIR") build_nss_layer "$d" "$layer" "$split" ;;
      *) build_cert_layer "$d" "$layer" "$split" ;;
    esac || { rm -rf "$layer"; continue; }
    say "prepared $d"
  done
  rm -rf "$split"
}

mount_layers() {
  mounted=0
  for d in $ALL_DIRS; do
    layer=$(layer_for "$d")
    [ -d "$d" ] && [ -d "$layer" ] || continue
    if mount -t overlay -o "ro,lowerdir=$layer:$d" "$(source_for "$d")" "$d"; then
      say "mounted $d"
      mounted=$((mounted + 1))
    else
      say "failed to mount $d"
    fi
  done
  [ "$mounted" -gt 0 ] || die "nothing mounted"
}

apply() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  [ -f "$HOME_DIR/$BUNDLE" ] || die "not installed (run: $0 install)"
  grep -qw overlay /proc/filesystems || die "kernel lacks overlayfs (needs webOS 3.5 or later)"

  unmount_all
  stamp=$(fingerprint)
  if [ "$stamp" != "$(cat "$HOME_DIR/stamp" 2>/dev/null)" ] || [ ! -d "$LAYERS" ]; then
    say "building layers"
    # Kept separately: boot runs reuse the layers and overwrite last.log.
    build_layers 2>&1 | tee "$HOME_DIR/build.log"
    echo "$stamp" >"$HOME_DIR/stamp"
  fi
  mount_layers
  say "done; restart the web engine for web apps to pick up the change"
}

# Backgrounded with a delay so a caller running inside WebAppMgr (the app, via Homebrew Channel's
# exec service) gets its response before WebAppMgr goes away.
restart_web_engine() {
  if initctl status WebAppMgr 2>/dev/null | grep -q running; then
    say "restarting WebAppMgr"
    (sleep 1; initctl restart WebAppMgr) >/dev/null 2>&1 &
  else
    say "WebAppMgr not running; nothing to restart"
  fi
}

# Runs an action with its output also saved to a log, since boot runs have no terminal.
logged() {
  log=/tmp/$NAME.log
  [ -d "$HOME_DIR" ] && log=$HOME_DIR/last.log
  ("$@") >"$log" 2>&1
  rc=$?
  cat "$log"
  return $rc
}

install() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  src=$(cd "$(dirname "$0")" && pwd)
  [ -f "$src/$BUNDLE" ] || die "$BUNDLE not found next to $0"
  mkdir -p "$HOME_DIR" "${HOOK%/*}"
  if [ "$src" != "$HOME_DIR" ]; then
    cp "$src/$NAME.sh" "$HOME_DIR/$NAME.sh" && cp "$src/$BUNDLE" "$HOME_DIR/$BUNDLE" || die "copy failed"
  fi
  chmod 755 "$HOME_DIR/$NAME.sh"
  cat >"$HOOK" <<EOF
#!/bin/sh
# Installed by Cathode Cinema (com.unofficial.cathodetv): adds newer root CAs at boot.
# Remove with: $HOME_DIR/$NAME.sh uninstall
exec $HOME_DIR/$NAME.sh boot
EOF
  chmod 755 "$HOOK"
  say "installed boot hook $HOOK"
  "$HOME_DIR/$NAME.sh" apply
}

status() {
  if [ -f "$HOME_DIR/$BUNDLE" ]; then
    say "installed: $(grep -m1 'as of:' "$HOME_DIR/$BUNDLE" | sed 's/.*as of: //')"
  else
    say "not installed"
  fi
  [ -x "$HOOK" ] && say "boot hook: $HOOK" || say "boot hook: missing"
  for d in $ALL_DIRS; do
    if [ ! -d "$d" ]; then say "$d: absent"
    elif is_ours "$d"; then say "$d: mounted"
    elif [ -n "$(top_mount "$d")" ]; then say "$d: not mounted (covered by $(top_mount "$d"))"
    else say "$d: not mounted"
    fi
  done
}

uninstall() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  unmount_all
  rm -f "$HOOK"
  rm -rf "$HOME_DIR"
  say "removed; stock certificate stores restored"
}

case ${1:-} in
  install) install ;;
  apply) logged apply ;;
  boot) logged apply && restart_web_engine ;;
  restart-web-engine) restart_web_engine ;;
  status) status ;;
  uninstall) uninstall ;;
  *) echo "usage: $0 install|apply|boot|restart-web-engine|status|uninstall" >&2; exit 2 ;;
esac

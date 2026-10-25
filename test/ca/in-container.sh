#!/bin/sh
# Exercises ca/cathode-ca.sh against a fake "old TV" whose stores lack ok.ru's HARICA root.
# Runs inside a privileged Alpine container (busybox ash, like webOS); see test/ca/run.sh.
set -u

apk add --no-cache -q openssl nss-tools >/dev/null || { echo "apk failed"; exit 1; }

export CATHODE_CA_ROOT=/tv
CHAIN=/fixtures/ok.ru-chain-2026-10-25.pem
AT=1792954800  # 2026-10-25, so the saved chain stays "valid" in this test
SCRIPT=/tv/var/lib/webosbrew/cathode-ca/cathode-ca.sh
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { desc=$1; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }
refute() { desc=$1; shift; if "$@" >/dev/null 2>&1; then fail "$desc"; else pass "$desc"; fi; }

awk 'BEGIN{n=0} /BEGIN CERT/{n++} n==1{print}' "$CHAIN" >/tmp/leaf.pem
verify_dir() { openssl verify -no-CAfile -no-CApath -attime "$AT" -CApath "$1" -untrusted "$CHAIN" /tmp/leaf.pem; }
verify_file() { openssl verify -no-CAfile -no-CApath -attime "$AT" -CAfile "$1" -untrusted "$CHAIN" /tmp/leaf.pem; }
nss_count() { certutil -L -d "sql:/tv/etc/pki/nssdb" 2>/dev/null | grep -c 'cathode-ca-root'; }
stock_sum() { find /tv/etc /tv/usr /tv/var/palm -type f -exec md5sum {} + | sort | md5sum; }

# --- build the fake TV: a store that only knows a couple of old roots
mkdir -p /tv/etc/ssl/certs /tv/var/palm/jail/com.webos.app.browser/etc/ssl/certs \
         /tv/usr/share/ca-certificates/sdp /tv/etc/pki/nssdb
# Any root other than HARICA's stands in for the TV's existing list.
awk '/BEGIN CERT/{n++} n==1{print} /END CERT/{if(n==1)exit}' /app/ca/mozilla-roots.pem >/tmp/old-root.pem
grep -q "HARICA\|Hellenic" /tmp/old-root.pem && { echo "fixture root is HARICA"; exit 1; }
for d in /tv/etc/ssl/certs /tv/var/palm/jail/com.webos.app.browser/etc/ssl/certs; do
  cp /tmp/old-root.pem "$d/Old_Root.pem"
  ln -s Old_Root.pem "$d/$(openssl x509 -in /tmp/old-root.pem -noout -subject_hash).0"
  cp /tmp/old-root.pem "$d/ca-certificates.crt"
done
cp /tmp/old-root.pem /tv/usr/share/ca-certificates/sdp/sdp-ca.pem
certutil -N -d sql:/tv/etc/pki/nssdb --empty-password
before=$(stock_sum)

refute "old TV store rejects ok.ru (CApath)" verify_dir /tv/etc/ssl/certs
refute "old TV store rejects ok.ru (bundle)" verify_file /tv/etc/ssl/certs/ca-certificates.crt

# --- install from the app's packaged copy
sh /app/ca/cathode-ca.sh install >/tmp/install.log 2>&1
check "install exits 0" test $? -eq 0
check "boot hook is executable" test -x /tv/var/lib/webosbrew/init.d/cathode-ca
check "boot hook name is run-parts compatible" sh -c 'ls /tv/var/lib/webosbrew/init.d | grep -qx "[A-Za-z0-9_-]*"'
check "ok.ru verifies via CApath" verify_dir /tv/etc/ssl/certs
check "ok.ru verifies via bundle" verify_file /tv/etc/ssl/certs/ca-certificates.crt
check "ok.ru verifies via browser jail" verify_dir /tv/var/palm/jail/com.webos.app.browser/etc/ssl/certs
check "ok.ru verifies via sdp bundle" verify_file /tv/usr/share/ca-certificates/sdp/sdp-ca.pem
check "original root still trusted" grep -q "$(sed -n 2p /tmp/old-root.pem)" /tv/etc/ssl/certs/ca-certificates.crt
n=$(nss_count)
check "NSS has all 118 roots (got $n)" test "$n" -eq 118
check "overlay is read-only" sh -c '! touch /tv/etc/ssl/certs/x 2>/dev/null'

# --- re-apply (what happens at every boot) is idempotent and doesn't rebuild
sh "$SCRIPT" apply >/tmp/apply2.log 2>&1
check "re-apply exits 0" test $? -eq 0
refute "re-apply reuses cached layers" grep -q "building layers" /tmp/apply2.log
mounts=$(grep -c '^cathode-ca' /proc/mounts)
check "one overlay per store after re-apply (got $mounts)" test "$mounts" -eq 4
check "ok.ru still verifies" verify_dir /tv/etc/ssl/certs
check "status reports mounted" sh -c "sh $SCRIPT status | grep -q '/tv/etc/ssl/certs: mounted'"

# --- a firmware update to a stock store triggers a rebuild
umount /tv/etc/ssl/certs && echo "# firmware update" >>/tv/etc/ssl/certs/ca-certificates.crt
sh "$SCRIPT" apply >/tmp/apply3.log 2>&1
check "changed stock store triggers rebuild" grep -q "building layers" /tmp/apply3.log
check "rebuilt bundle keeps the firmware change" grep -q "firmware update" /tv/etc/ssl/certs/ca-certificates.crt
umount /tv/etc/ssl/certs; sed -i '/# firmware update/d' /tv/etc/ssl/certs/ca-certificates.crt
sh "$SCRIPT" apply >/dev/null 2>&1

# --- boot hook: apply, then restart the web engine (it caches the CA bundle at startup)
mkdir -p /fakebin
cat >/fakebin/initctl <<'STUB'
#!/bin/sh
echo "$*" >>/tmp/initctl.calls
[ "$1" = status ] && echo "$2 start/running, process 3069"
exit 0
STUB
chmod 755 /fakebin/initctl
check "boot hook runs the boot action" grep -q "cathode-ca.sh boot$" /tv/var/lib/webosbrew/init.d/cathode-ca
PATH=/fakebin:$PATH sh "$SCRIPT" boot >/tmp/boot.log 2>&1
check "boot exits 0" test $? -eq 0
sleep 2
check "boot restarts WebAppMgr after mounting" grep -qx "restart WebAppMgr" /tmp/initctl.calls
check "ok.ru verifies after boot" verify_dir /tv/etc/ssl/certs
: >/tmp/initctl.calls
sh "$SCRIPT" boot >/dev/null 2>&1   # no initctl on PATH: must not fail
check "boot without initctl still exits 0" test $? -eq 0

# --- uninstall restores stock exactly
sh "$SCRIPT" uninstall >/tmp/uninstall.log 2>&1
check "uninstall exits 0" test $? -eq 0
check "no overlays left" sh -c '! grep -q "^cathode-ca" /proc/mounts'
check "boot hook removed" test ! -e /tv/var/lib/webosbrew/init.d/cathode-ca
refute "ok.ru rejected again" verify_dir /tv/etc/ssl/certs
check "stock files byte-identical to before" test "$(stock_sum)" = "$before"

if [ "$fails" -gt 0 ]; then
  echo; echo "--- install log"; cat /tmp/install.log
fi
echo; echo "$fails failure(s)"
exit "$fails"

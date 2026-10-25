#!/bin/sh
# Read-only report of how this TV's web engine verifies certificates, for working out which store
# cathode-ca.sh has to cover. Changes nothing. Run as root over SSH:
#   sh diagnose.sh > /tmp/cathode-diag.txt; cat /tmp/cathode-diag.txt

echo "== system"
cat /var/run/nyx/os_info.json 2>/dev/null | tr -s ' \n' ' ' | cut -c1-400; echo
uname -r
grep -qw overlay /proc/filesystems && echo "overlayfs: yes" || echo "overlayfs: no"
for t in openssl certutil; do echo "$t: $(command -v "$t" || echo missing)"; done

echo "== cathode-ca state"
grep '^cathode-ca' /proc/mounts || echo "no cathode-ca mounts"
ls /var/lib/webosbrew/cathode-ca/layers 2>/dev/null || echo "no layers"
for f in build.log last.log; do
  [ -f "/var/lib/webosbrew/cathode-ca/$f" ] && { echo "-- $f"; cat "/var/lib/webosbrew/cathode-ca/$f"; }
done
for d in /etc/pki/nssdb /etc/pki /root/.pki/nssdb /home/root/.pki/nssdb; do
  [ -e "$d" ] && echo "exists: $d" || echo "absent: $d"
done

echo "== web engine processes (first of each name)"
seen=" "
for p in /proc/[0-9]*; do
  comm=$(cat "$p/comm" 2>/dev/null) || continue
  case $comm in WebAppMgr*|*wam*|*WAM*|*rowser*|*hromium*|*enderer*|*Zygote*|*zygote*) ;; *) continue ;; esac
  case $seen in *" $comm "*) continue ;; esac
  seen="$seen$comm "
  echo "-- pid ${p#/proc/} $comm uid=$(awk '/^Uid:/{print $2}' "$p/status" 2>/dev/null)"
  tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -E '^(HOME|USER|NSS_|SSL_CERT|XDG_)'
  echo "   root: $(readlink "$p/root" 2>/dev/null)"
  awk '{print $6}' "$p/maps" 2>/dev/null | grep -iE 'nss|ssl|crypto|ckbi|softokn|freebl|boring' | sort -u | sed 's/^/   lib: /'
  ls -l "$p/fd" 2>/dev/null | grep -iE 'pki|nss|cert|\.db' | sed 's/^.*-> /   open: /'
done

echo "== NSS databases and root modules on disk"
find / \( -path /proc -o -path /sys -o -path /dev -o -path /tmp \) -prune -o \
  \( -name 'cert9.db' -o -name 'cert8.db' -o -name 'pkcs11.txt' -o -name 'libnssckbi.so*' \) \
  -print 2>/dev/null | head -40

echo "== other CA bundles"
find / \( -path /proc -o -path /sys -o -path /dev -o -path /tmp -o -path /var/lib/webosbrew \) -prune -o \
  \( -name 'ca-certificates.crt' -o -name 'trusted_cas.crt' -o -name 'ca-bundle*.crt' \
     -o -name 'cacert*.pem' -o -name 'sdp-ca.pem' \) -print 2>/dev/null | head -40

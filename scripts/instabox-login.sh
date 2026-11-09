#!/bin/sh
# Log in to an Instabox machine for a remote Bot sandbox (local-tools sandbox.sshLoginCommand):
# renews the short-lived SSH certificate and writes the host alias instabox-<machine> that
# sandbox.ssh names, because `instabox ssh-cert` only writes the key and certificate.
# Usage: instabox-login.sh <machine>. The API key comes from INSTABOX_API_KEY, or the file in
# INSTABOX_API_KEY_FILE (default /run/aeeis-secrets/instabox-key). Version pinned on purpose.
set -eu
machine="${1:?usage: instabox-login.sh <machine>}"
case "$machine" in *[!A-Za-z0-9_-]*) echo "instabox-login: invalid machine name" >&2; exit 2 ;; esac
if [ -z "${INSTABOX_API_KEY:-}" ]; then
  INSTABOX_API_KEY="$(cat "${INSTABOX_API_KEY_FILE:-/run/aeeis-secrets/instabox-key}")"
fi
export INSTABOX_API_KEY
dir="$HOME/.config/instabox/ssh"
out="$(npx -y instabox@0.8.186 ssh-cert "$machine" </dev/null)"
# Prints "<path>/<user>-cert.pub (expires <time>)".
cert="$(printf '%s\n' "$out" | sed -n 's/ (expires .*//p' | tail -n 1)"
case "$cert" in "$dir"/*-cert.pub) ;; *) echo "instabox-login: unexpected ssh-cert output" >&2; exit 1 ;; esac
[ -f "$cert" ] && [ -f "$dir/id_ed25519" ] && [ -f "$dir/known_hosts" ] || { echo "instabox-login: key, certificate or known_hosts missing" >&2; exit 1; }
user="$(basename "$cert" -cert.pub)"
tmp="$dir/.aeeis-$machine.conf.$$"
umask 077
cat > "$tmp" <<EOF
# Written by instabox-login.sh for $machine.
Host instabox-$machine
  HostName ssh.instabox.sh
  Port 2222
  User $user
  IdentityFile $dir/id_ed25519
  CertificateFile $cert
  IdentitiesOnly yes
  UserKnownHostsFile $dir/known_hosts
  StrictHostKeyChecking yes
  UpdateHostKeys no
EOF
mv "$tmp" "$dir/aeeis-$machine.conf"

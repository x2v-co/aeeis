"""Prints a short fingerprint of the secrets directory the API mounts (deploy/stack/compose.yml).

Compose recreates a container only when its rendered configuration changes, and a bind-mounted directory's files are
not part of it. The API carries this fingerprint as a label, so editing local-tools.json or replacing a key file makes
the next `up` restart the API. Only names, sizes, modes, owners and modification times go in, never contents, so the
label says nothing about the secrets. A directory that does not exist prints "absent"; one that cannot be read in
full (permissions) fails, because a fingerprint that misses files would leave the API on old settings unnoticed.
Usage: python3 -I _secrets-fingerprint.py <directory>
"""
import hashlib
import os
import sys

root = sys.argv[1]
try:
    os.stat(root)
except FileNotFoundError:
    print('absent')
    sys.exit(0)
digest = hashlib.sha256()
def entry(path):
    info = os.lstat(path)
    rel = os.path.relpath(path, root)
    digest.update(f'{rel}\0{info.st_mode}\0{info.st_uid}\0{info.st_size}\0{info.st_mtime_ns}\n'.encode('utf-8', 'surrogateescape'))
def unreadable(error):
    raise error
for directory, directories, files in os.walk(root, onerror=unreadable):
    directories.sort()
    for name in sorted(directories + files):
        entry(os.path.join(directory, name))
print(digest.hexdigest()[:16])

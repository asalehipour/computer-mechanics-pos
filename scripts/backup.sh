#!/usr/bin/env bash
# backup.sh — Pull the live Railway volume contents into a local timestamped
# folder. Complements the in-app Settings → "Download backup" button by giving
# you a scriptable, offline path.
#
# Requires: railway CLI (brew install railway), logged in, and this directory
# linked with `railway link`.
#
# Usage:
#   ./scripts/backup.sh              # pulls into ./backups/pos-backup-YYYY-MM-DD-HHMM/
#   ./scripts/backup.sh /some/path   # pulls into /some/path/ instead
#
# What it grabs: everything under /app/data on the Railway volume — job-board,
# attachments, passwords, settings, encryption key. Treat the output folder
# as sensitive.

set -euo pipefail

# Resolve repo root so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

STAMP=$(date +"%Y-%m-%d-%H%M")
DEST_BASE="${1:-$REPO_ROOT/backups}"
DEST="$DEST_BASE/pos-backup-$STAMP"

echo "→ Backing up Railway volume → $DEST"
mkdir -p "$DEST"

# Sanity-check the link. `railway status` fails if not linked.
if ! railway status >/dev/null 2>&1; then
  echo "✗ Not linked to a Railway project. Run: railway link" >&2
  exit 1
fi

# 1. Enumerate files on the volume.
echo "→ Listing remote files…"
FILE_LIST=$(railway ssh 'find /app/data -type f -printf "%p\t%s\n" 2>/dev/null || find /app/data -type f')
if [ -z "$FILE_LIST" ]; then
  echo "✗ No files found under /app/data on the volume." >&2
  exit 1
fi

# 2. Tar everything on the server, base64-encode, and pull it down in chunks.
# We use tar so empty dirs and symlinks round-trip correctly. base64 because
# Railway's SSH wraps stdin/stdout in a PTY and mangles binary bytes.
echo "→ Packaging remote /app/data into tar.gz…"
railway ssh 'tar czf /tmp/pos-backup.tgz -C /app data && wc -c /tmp/pos-backup.tgz'

# 3. Stream the tar.gz out as base64. Railway ssh truncates very large single
# outputs so we base64 it into a file on the server, then fetch that file in
# chunks using dd + offset.
echo "→ Encoding remote archive…"
railway ssh 'base64 /tmp/pos-backup.tgz > /tmp/pos-backup.b64 && wc -c /tmp/pos-backup.b64'

TOTAL_B64=$(railway ssh 'wc -c < /tmp/pos-backup.b64' | tr -d '[:space:]')
echo "→ Remote base64 size: $TOTAL_B64 bytes"

CHUNK=65536 # 64 KB per ssh call
OFFSET=0
LOCAL_B64="$DEST/pos-backup.b64"
: > "$LOCAL_B64"

echo "→ Pulling in $CHUNK-byte chunks…"
while [ "$OFFSET" -lt "$TOTAL_B64" ]; do
  # Use tail + head to slice a byte range out of the remote file.
  railway ssh "tail -c +$((OFFSET+1)) /tmp/pos-backup.b64 | head -c $CHUNK" \
    >> "$LOCAL_B64"
  OFFSET=$((OFFSET + CHUNK))
  printf "  %d / %d bytes\r" "$OFFSET" "$TOTAL_B64"
done
echo ""

# 4. Decode and extract locally.
echo "→ Decoding + extracting locally…"
base64 -d < "$LOCAL_B64" > "$DEST/pos-backup.tgz"
rm -f "$LOCAL_B64"
tar xzf "$DEST/pos-backup.tgz" -C "$DEST"
rm -f "$DEST/pos-backup.tgz"

# 5. Clean up the server-side temp files.
railway ssh 'rm -f /tmp/pos-backup.tgz /tmp/pos-backup.b64' >/dev/null 2>&1 || true

echo ""
echo "✓ Done. Backup at: $DEST"
du -sh "$DEST" 2>/dev/null || true

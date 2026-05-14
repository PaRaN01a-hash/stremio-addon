#!/bin/bash

set -e

# -------------------------
# TELEGRAM SETTINGS (EDIT THIS)
# -------------------------
TG_TOKEN="8798981524:AAFzWEJhtWaAV9kXCk18JRLRS3r2imrsick"
TG_CHAT="5956354304"

# -------------------------
# ERROR HANDLER (sends FAIL message)
# -------------------------
trap 'curl -s "https://api.telegram.org/bot$TG_TOKEN/sendMessage?chat_id=$TG_CHAT&text=Backup%20FAILED%20$(date +%F)" || true' ERR

# -------------------------
# RCLONE CONFIG
# -------------------------
export RCLONE_CONFIG=/home/ubuntu/.config/rclone/rclone.conf

DATE=$(date +%F)
BACKUP_NAME="server-backup-$DATE"
WORK_DIR="/tmp/$BACKUP_NAME"

# Always clean up temp files
trap 'rm -rf "$WORK_DIR"' EXIT

echo "🔵 Starting backup for $DATE"

# -------------------------
# TELEGRAM START MESSAGE
# -------------------------
curl -s "https://api.telegram.org/bot$TG_TOKEN/sendMessage?chat_id=$TG_CHAT&text=Backup%20started%20$(date +%F)"

# -------------------------
# Create working dir
# -------------------------
mkdir -p "$WORK_DIR"

# -------------------------
# Copy configs
# -------------------------
echo "📦 Copying configs..."

cp -r /home/ubuntu/programs/npm "$WORK_DIR/npm" 2>/dev/null || true
cp -r /home/ubuntu/programs/nextcloud/nextcloud/config "$WORK_DIR/nextcloud-config" 2>/dev/null || true

# -------------------------
# Nextcloud DB
# -------------------------
echo "🗄️ Dumping Nextcloud DB..."

docker exec nextcloud-db \
  mysqldump -u root -prootpassword nextcloud \
  > "$WORK_DIR/nextcloud.sql" 2>/dev/null \
  || { echo "❌ Nextcloud DB backup failed"; exit 1; }

# -------------------------
# Immich DB
# -------------------------
echo "🗄️ Dumping Immich DB..."

docker exec -i immich_postgres \
  env PGPASSWORD=immich \
  pg_dumpall -U immich \
  > "$WORK_DIR/immich.sql" 2>/dev/null \
  || { echo "❌ Immich DB backup failed"; exit 1; }

# -------------------------
# Filebrowser DB
# -------------------------
echo "📁 Copying Filebrowser DB..."

cp /home/ubuntu/programs/filebrowser/data/filebrowser.db "$WORK_DIR/" 2>/dev/null || true

# -------------------------
# Maximus local index memory
# -------------------------
# -------------------------
# Maximus memory prewarm
# -------------------------
echo "🌱 Prewarming Maximus local-index memory..."

if [ -x /home/ubuntu/stremio-addon/scripts/core-engine-prewarm.py ]; then
  /home/ubuntu/stremio-addon/scripts/core-engine-prewarm.py \
    --base http://localhost:6000 \
    --seeds /home/ubuntu/stremio-addon/data/core-engine-prewarm-seeds.json \
    --timeout 90 \
    || echo "⚠️ Maximus prewarm had warnings, continuing backup"
else
  echo "⚠️ Maximus prewarm tool not found, skipping"
fi

echo "🧠 Exporting Maximus local-index memory..."

if [ -x /home/ubuntu/stremio-addon/scripts/local-index-memory.py ]; then
  /home/ubuntu/stremio-addon/scripts/local-index-memory.py export \
    --container stremio-redis \
    --file "$WORK_DIR/maximus-local-index-memory-$DATE.json" \
    || { echo "❌ Maximus local-index memory backup failed"; exit 1; }
else
  echo "⚠️ Maximus memory backup tool not found, skipping"
fi


# -------------------------
# Upload (Incremental)
# -------------------------
echo "☁️ Uploading incremental backup..."

rclone sync "$WORK_DIR" gdrive:server-backups/current \
  --copy-links \
  --transfers=4 \
  --checkers=8 \
  --progress

# -------------------------
# Snapshot (daily copy)
# -------------------------
echo "📸 Creating daily snapshot..."

rclone copy "$WORK_DIR" gdrive:server-backups/$DATE \
  --copy-links \
  --transfers=4 \
  --checkers=8 \
  --progress

# -------------------------
# Retention (7 days)
# -------------------------
echo "🗑️ Removing old backups..."

rclone delete gdrive:server-backups --min-age 7d --rmdirs

# -------------------------
# Get size BEFORE cleanup
# -------------------------
SIZE=$(du -sh "$WORK_DIR" 2>/dev/null | cut -f1)

# -------------------------
# Vaultwarden
# -------------------------
tar -czf /home/ubuntu/backups/vaultwarden-$(date +%F).tar.gz /home/ubuntu/programs/vaultwarden/data || echo "❌ Vaultwarden backup failed"

# -------------------------
# Cleanup
# -------------------------
echo "🧹 Cleaning up..."
rm -rf "$WORK_DIR"

echo "✅ Backup complete"

# -------------------------
# TELEGRAM SUCCESS MESSAGE
# -------------------------
curl -s "https://api.telegram.org/bot$TG_TOKEN/sendMessage?chat_id=$TG_CHAT&text=Backup%20complete%20$SIZE%20$(date +%F)"

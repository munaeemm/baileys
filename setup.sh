#!/bin/bash
set -e

echo "=== Bailey Manager Setup ==="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Install manager deps
echo "[1/2] Installing manager dependencies..."
cd "$SCRIPT_DIR/manager"
npm install

echo "[2/2] Starting Bailey Manager with PM2..."
pm2 start server.js --name bailey-manager --cwd "$SCRIPT_DIR/manager"
pm2 save

echo ""
echo "✓ Bailey Manager is running at http://localhost:7400"
echo ""
echo "Next steps:"
echo "  1. Open http://localhost:7400 (or via your Cloudflare tunnel)"
echo "  2. Enter your Supabase URL + key and save"
echo "  3. Click '+ Add Number' to create your first instance"
echo "  4. Scan the QR code with WhatsApp"
echo ""
echo "To update all instances after editing template/index.js:"
echo "  → Click 'Update All Instances' in the UI"
echo "  OR: curl -X POST http://localhost:7400/api/update-all"

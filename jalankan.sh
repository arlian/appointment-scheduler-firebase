#!/usr/bin/env bash
# Menjalankan aplikasi Jadwal Treatment lewat server Python.
# Hentikan dengan Ctrl+C.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
URL="http://localhost:$PORT"

# Jalankan server di latar belakang (dengan header anti-cache agar
# pembaruan aplikasi langsung terlihat cukup dengan refresh biasa)
python3 - "$PORT" <<'PYEOF' &
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

port = int(sys.argv[1])
print(f'Serving HTTP on 127.0.0.1 port {port} ...')
HTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
PYEOF
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# Tunggu server siap (maks 10 detik)
for _ in $(seq 1 20); do
  if curl -sf "$URL" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

# Buka browser
if command -v wslview >/dev/null 2>&1; then
  wslview "$URL"                       # WSL dengan wslu
elif command -v explorer.exe >/dev/null 2>&1; then
  explorer.exe "$URL" || true          # WSL: browser default Windows
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"                      # Linux desktop
elif command -v open >/dev/null 2>&1; then
  open "$URL"                          # macOS
else
  echo "Buka manual di browser: $URL"
fi

echo "Aplikasi berjalan di $URL — tekan Ctrl+C untuk berhenti."
wait $SERVER_PID

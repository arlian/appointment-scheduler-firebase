#!/usr/bin/env python3
# Server statis dengan header anti-cache untuk Jadwal Treatment.
# Dipakai oleh jalankan.bat.
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'Serving HTTP on 127.0.0.1 port {port} ...')
    HTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()


if __name__ == '__main__':
    main()

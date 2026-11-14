#!/usr/bin/env python3
"""Disposable, loopback-only two-browser environment using real API/PostgreSQL."""
import argparse
import base64
import functools
import http.client
import http.server
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class LostReadingResponses:
    """Drop one successful response per reading endpoint, per frontend."""
    paths = frozenset(('/api/v1/reading-sessions/apply',
                       '/api/v1/reading-coverage/apply'))

    save_paths = frozenset(('/api/v1/positions/choose',
                            '/api/v1/bookmarks/apply'))

    def __init__(self, enabled=False, save_enabled=False):
        self.remaining = (set(self.paths) if enabled else set()) | (set(self.save_paths) if save_enabled else set())
        self.lock = threading.Lock()

    def consume(self, method, path, status):
        if method != 'POST' or not 200 <= status < 300:
            return False
        with self.lock:
            if path not in self.remaining:
                return False
            self.remaining.remove(path)
            return True


class Frontend(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/') or self.path in ('/readyz', '/healthz'):
            return self.proxy()
        path = self.translate_path(self.path.split('?', 1)[0])
        if not Path(path).is_file() and not Path(self.path.split('?', 1)[0]).suffix:
            self.path = '/index.html'
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self.proxy()
        self.send_error(404)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def proxy(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.api_port, timeout=35)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 2 * 1024 * 1024:
                self.send_error(413)
                return
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in ('host', 'connection', 'transfer-encoding')}
            connection.request(self.command, self.path, self.rfile.read(size), headers)
            response = connection.getresponse()
            body = response.read()
            # The real API has finished and committed. Withhold the entire
            # response so the real browser must retry its uncertain operation.
            if self.server.lost_responses.consume(self.command, self.path, response.status):
                print(f'Lost successful reading response: frontend={self.server.server_port} path={self.path}', flush=True)
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass  # The client may already have disconnected.
                return
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('connection', 'transfer-encoding', 'content-length', 'cache-control'):
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (OSError, http.client.HTTPException, ValueError):
            self.send_error(502)
        finally:
            connection.close()


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--postgres-container', default='ops-postgres-1')
    parser.add_argument('--drop-first-reading-response', action='store_true',
                        help='Drop the first successful time and coverage POST response on each frontend, after API commit')
    parser.add_argument('--drop-first-save-response', action='store_true',
                        help='Drop the first successful position and bookmark POST response on each frontend, after API commit')
    args = parser.parse_args()
    container = args.postgres_container
    database = 'journey_' + secrets.token_hex(8)
    processes, servers = [], []
    created = False

    def sql(command):
        return subprocess.run(['docker', 'exec', '-i', container, 'psql', '-X',
                               '-v', 'ON_ERROR_STOP=1', '-U', 'lumyboo',
                               '-d', database], input=command, text=True, check=True)

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        # Bind first: an occupied port must fail before provisioning anything.
        handler = functools.partial(Frontend, directory=str(ROOT / 'apps/web/dist'))
        for port in (4311, 4312):
            server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
            server.lost_responses = LostReadingResponses(args.drop_first_reading_response, args.drop_first_save_response)
            servers.append(server)
        subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True)
        with tempfile.TemporaryDirectory(prefix='lumyboo-journey-') as temporary:
            binary = str(Path(temporary) / 'api')
            subprocess.run(['go', 'build', '-o', binary, './cmd/api'],
                           cwd=ROOT / 'services/api', check=True)
            subprocess.run(['docker', 'exec', container, 'createdb', '-U', 'lumyboo', database], check=True)
            created = True
            for migration in sorted((ROOT / 'services/api/db/migrations').glob('*.up.sql')):
                sql(migration.read_text())
            secret = base64.b64encode(secrets.token_bytes(32)).decode()
            for server, host, api_port in zip(servers, ('127.0.0.1', 'localhost'), (8311, 8312)):
                origin = f'http://{host}:{server.server_port}'
                env = dict(os.environ, DATABASE_URL=f'postgres://lumyboo:local-development-only@127.0.0.1:5432/{database}?sslmode=disable',
                           API_ADDRESS=f'127.0.0.1:{api_port}', APP_ENV='development',
                           PUBLIC_ORIGIN=origin, AUTH_SECRET=secret,
                           SMTP_ADDRESS='127.0.0.1:1025', SMTP_FROM='login@lumyboo.local',
                           SMTP_ALLOW_INSECURE='true', SMTP_USERNAME='', SMTP_PASSWORD='',
                           TRUSTED_PROXY_CIDRS='')
                process = subprocess.Popen([binary], env=env)
                processes.append(process)
                for attempt in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('API exited before readiness')
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{api_port}/readyz', timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise RuntimeError('API readiness timed out')
                server.api_port = api_port
                threading.Thread(target=server.serve_forever, daemon=True).start()
                print(f'Browser: {origin}', flush=True)
            print('Mailpit: http://127.0.0.1:8025 — use a unique @example.test email.', flush=True)
            if args.drop_first_reading_response:
                print('Response loss enabled: first successful time/coverage POST reply on EACH frontend will be disconnected after API commit.', flush=True)
            if args.drop_first_save_response:
                print('Response loss enabled: first successful position/bookmark POST reply on EACH frontend will be disconnected after API commit.', flush=True)
            print('Separate cookies/IndexedDB; shared disposable database. Ctrl+C cleans up.', flush=True)
            while True:
                if any(process.poll() is not None for process in processes):
                    raise RuntimeError('API stopped during the journey')
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for server in servers:
            server.server_close()
        if created:
            subprocess.run(['docker', 'exec', container, 'dropdb', '-U', 'lumyboo', database], check=True)


if __name__ == '__main__':
    run()

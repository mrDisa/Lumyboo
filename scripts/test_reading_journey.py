"""Verify the local fault injector drops replies only after upstream success."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import http.server
import threading
import unittest

from reading_journey import Frontend, JourneyControls, LostReadingResponses


class ReadingResponseLossTests(unittest.TestCase):
    def test_terminal_controls_are_explicit_and_isolated(self):
        class Server:
            def __init__(self):
                self.api_offline = threading.Event()
        a, b = Server(), Server()
        expirations = []
        controls = JourneyControls([a, b], lambda: expirations.append(True))
        for command in ('', 'expire a', 'offline', 'offline c', 'online a extra'):
            self.assertTrue(controls.execute(command).startswith('Commands:'))
        self.assertEqual(expirations, [])
        controls.execute('offline a')
        self.assertTrue(a.api_offline.is_set())
        self.assertFalse(b.api_offline.is_set())
        controls.execute('offline b')
        controls.execute('online a')
        self.assertFalse(a.api_offline.is_set())
        self.assertTrue(b.api_offline.is_set())
        controls.execute('expire')
        self.assertEqual(expirations, [True])
        self.assertTrue(b.api_offline.is_set())

    def test_disabled_and_non_reading_requests_never_drop(self):
        path = '/api/v1/reading-sessions/apply'
        self.assertFalse(LostReadingResponses().consume('POST', path, 200))
        faults = LostReadingResponses(True)
        for method, url, status in [('GET', path, 200), ('POST', path, 401),
                                    ('POST', path, 503),
                                    ('POST', '/api/v1/auth/verify', 200)]:
            self.assertFalse(faults.consume(method, url, status))
        self.assertTrue(faults.consume('POST', path, 200))
        self.assertFalse(faults.consume('POST', path, 200))
        self.assertTrue(faults.consume('POST', '/api/v1/reading-coverage/apply', 200))

    def test_concurrent_requests_drop_once_and_frontends_are_independent(self):
        path = '/api/v1/reading-sessions/apply'
        faults = LostReadingResponses(True)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: faults.consume('POST', path, 200), range(50)))
        self.assertEqual(sum(results), 1)
        self.assertTrue(LostReadingResponses(True).consume('POST', path, 200))

    def test_save_faults_are_opt_in_and_do_not_consume_errors(self):
        faults = LostReadingResponses(save_enabled=True)
        for path in LostReadingResponses.save_paths:
            self.assertFalse(LostReadingResponses(True).consume('POST', path, 200))
            for method, status in [('GET', 200), ('POST', 401), ('POST', 409), ('POST', 503)]:
                self.assertFalse(faults.consume(method, path, status))
            self.assertTrue(faults.consume('POST', path, 200))
            self.assertFalse(faults.consume('POST', path, 200))
            self.assertTrue(LostReadingResponses(save_enabled=True).consume('POST', path, 200))
        for path in LostReadingResponses.paths:
            self.assertFalse(faults.consume('POST', path, 200))

    def test_logout_faults_require_success_and_are_opt_in(self):
        faults = LostReadingResponses(logout_enabled=True)
        for path in LostReadingResponses.logout_paths:
            self.assertFalse(LostReadingResponses(True, True).consume('POST', path, 204))
            for method, status in [('GET', 204), ('POST', 401), ('POST', 403), ('POST', 503)]:
                self.assertFalse(faults.consume(method, path, status))
            self.assertTrue(faults.consume('POST', path, 204))
            self.assertFalse(faults.consume('POST', path, 204))
        self.assertFalse(faults.consume('POST', '/api/v1/auth/verify', 200))

    def test_both_modes_can_be_combined(self):
        faults = LostReadingResponses(True, True)
        for path in LostReadingResponses.paths | LostReadingResponses.save_paths:
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: faults.consume('POST', path, 200), range(50)))
            self.assertEqual(sum(results), 1)

    def test_real_connection_is_closed_after_upstream_body_and_retry_is_forwarded(self):
        received = []

        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received.append((self.path, self.rfile.read(int(self.headers['Content-Length']))))
                body = b'{"committed":true}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class QuietFrontend(Frontend):
            def log_message(self, *args):
                pass

        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        frontend = http.server.ThreadingHTTPServer(('127.0.0.1', 0), QuietFrontend)
        frontend.api_port = upstream.server_port
        frontend.api_offline = threading.Event()
        frontend.lost_responses = LostReadingResponses(True, True, True)
        servers = [upstream, frontend]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            payload = b'{"operationId":"same-on-retry"}'

            def post(path):
                connection = http.client.HTTPConnection('127.0.0.1', frontend.server_port, timeout=3)
                try:
                    connection.request('POST', path, payload,
                                       {'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    return response.status, response.read()
                finally:
                    connection.close()

            path = '/api/v1/positions/choose'
            frontend.api_offline.set()
            with self.assertRaises(http.client.RemoteDisconnected):
                post(path)
            self.assertEqual(received, [])  # A transport outage never reaches the real API.
            self.assertIn(path, frontend.lost_responses.remaining)
            frontend.api_offline.clear()
            for path in sorted(LostReadingResponses.paths | LostReadingResponses.save_paths | LostReadingResponses.logout_paths):
                with self.subTest(path=path):
                    with self.assertRaises(http.client.RemoteDisconnected):
                        post(path)
                    self.assertEqual(received[-1], (path, payload))
                    self.assertEqual(post(path), (200, b'{"committed":true}'))
                    self.assertEqual(received[-2:], [(path, payload)] * 2)
            self.assertEqual(len(received), 12)
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == '__main__':
    unittest.main()

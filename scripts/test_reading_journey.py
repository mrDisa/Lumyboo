"""Verify the local fault injector drops replies only after upstream success."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import http.server
import threading
import unittest

from reading_journey import Frontend, LostReadingResponses


class ReadingResponseLossTests(unittest.TestCase):
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
        frontend.lost_responses = LostReadingResponses(True)
        servers = [upstream, frontend]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            payload = b'{"operationId":"same-on-retry"}'

            def post():
                connection = http.client.HTTPConnection('127.0.0.1', frontend.server_port, timeout=3)
                try:
                    connection.request('POST', '/api/v1/reading-sessions/apply', payload,
                                       {'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    return response.status, response.read()
                finally:
                    connection.close()

            with self.assertRaises(http.client.RemoteDisconnected):
                post()
            self.assertEqual(len(received), 1)
            self.assertEqual(post(), (200, b'{"committed":true}'))
            self.assertEqual(received, [('/api/v1/reading-sessions/apply', payload)] * 2)
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == '__main__':
    unittest.main()

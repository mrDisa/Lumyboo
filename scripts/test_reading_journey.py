"""Verify the local fault injector drops replies only after upstream success."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import http.server
import io
import json
import threading
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

from reading_journey import Frontend, JourneyControls, LostReadingResponses


class ReadingResponseLossTests(unittest.TestCase):
    def test_trace_distinguishes_delivery_cancellation_and_upstream_failure(self):
        for failure in (None, 'client', 'upstream'):
            with self.subTest(failure=failure):
                handler = object.__new__(Frontend)
                handler.server = Mock(server_port=4311, trace_api=True,
                                      api_port=8311, api_offline=threading.Event(),
                                      lost_responses=LostReadingResponses())
                handler.command = 'GET'
                handler.path = '/api/v1/positions/?private=hidden-query'
                handler.headers = {'Cookie': 'hidden-cookie', 'Authorization': 'hidden-auth'}
                handler.rfile = io.BytesIO()
                handler.wfile = Mock()
                handler.send_response = Mock()
                handler.send_header = Mock()
                handler.end_headers = Mock()
                handler.send_error = Mock()
                response = Mock(status=200)
                response.getheader.return_value = 'test-request-id'
                response.getheaders.return_value = [('Set-Cookie', 'hidden-set-cookie')]
                response.read.return_value = b'hidden-body'
                connection = Mock()
                connection.getresponse.return_value = response
                if failure == 'client':
                    handler.wfile.write.side_effect = BrokenPipeError()
                if failure == 'upstream':
                    connection.getresponse.side_effect = ConnectionResetError()
                output = io.StringIO()
                with patch('reading_journey.http.client.HTTPConnection', return_value=connection), redirect_stdout(output):
                    handler.proxy()
                record = json.loads(output.getvalue())
                self.assertEqual(record['path'], '/api/v1/positions/')
                self.assertEqual(record['outcome'], {None: 'delivered', 'client': 'client_disconnected',
                                                    'upstream': 'upstream_error'}[failure])
                self.assertEqual(record['status'], None if failure == 'upstream' else 200)
                self.assertEqual(record['requestId'], None if failure == 'upstream' else 'test-request-id')
                self.assertGreaterEqual(record['elapsedMs'], 0)
                self.assertNotIn('hidden-', output.getvalue())
                if failure == 'upstream':
                    handler.send_error.assert_called_once_with(502)
                else:
                    handler.send_error.assert_not_called()
                connection.close.assert_called_once()

    def test_trace_is_opt_in_and_offline_is_identified(self):
        handler = object.__new__(Frontend)
        handler.server = Mock(server_port=4311, trace_api=False, api_offline=threading.Event())
        handler.server.api_offline.set()
        handler.command, handler.path = 'GET', '/api/v1/positions/'
        handler.connection = Mock()
        output = io.StringIO()
        with redirect_stdout(output):
            handler.proxy()
        self.assertEqual(output.getvalue(), '')
        handler.server.trace_api = True
        with redirect_stdout(output):
            handler.proxy()
        self.assertEqual(json.loads(output.getvalue())['outcome'], 'injected_offline')

    def test_terminal_controls_are_explicit_and_isolated(self):
        class Server:
            def __init__(self):
                self.api_offline = threading.Event()
                self.transport_offline = threading.Event()
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
        controls.execute('disconnect a')
        self.assertTrue(a.transport_offline.is_set())
        self.assertFalse(b.transport_offline.is_set())
        controls.execute('reconnect a')
        self.assertFalse(a.transport_offline.is_set())
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

    def test_verify_can_be_armed_after_normal_login_for_one_frontend_only(self):
        a = Mock(lost_responses=LostReadingResponses())
        b = Mock(lost_responses=LostReadingResponses())
        controls = JourneyControls([a, b], Mock())
        path = '/api/v1/auth/verify'
        self.assertFalse(a.lost_responses.consume('POST', path, 200))
        for command in ('lose-verify a', 'lose-verify c after-headers', 'lose-verify a invalid'):
            self.assertTrue(controls.execute(command).startswith('Commands:'))
        for mode in ('before-headers', 'after-headers'):
            controls.execute(f'lose-verify a {mode}')
            self.assertEqual(a.lost_responses.verify_mode, mode)
            self.assertFalse(b.lost_responses.consume('POST', path, 200))
            self.assertFalse(a.lost_responses.consume('POST', path, 401))
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: a.lost_responses.consume('POST', path, 200), range(50)))
            self.assertEqual(sum(results), 1)
        with self.assertRaises(ValueError):
            a.lost_responses.arm_verify('invalid')

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

    def test_verify_modes_require_success_and_are_opt_in(self):
        path = '/api/v1/auth/verify'
        self.assertFalse(LostReadingResponses(True, True, True).consume('POST', path, 200))
        for mode in ('before-headers', 'after-headers'):
            faults = LostReadingResponses(verify_mode=mode)
            for method, status in [('GET', 200), ('POST', 400), ('POST', 401), ('POST', 429), ('POST', 503)]:
                self.assertFalse(faults.consume(method, path, status))
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: faults.consume('POST', path, 200), range(50)))
            self.assertEqual(sum(results), 1)
            self.assertTrue(LostReadingResponses(verify_mode=mode).consume('POST', path, 200))

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
                self.send_header('Set-Cookie', 'session=test-only; HttpOnly; SameSite=Lax')
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
        frontend.transport_offline = threading.Event()
        frontend.lost_responses = LostReadingResponses(True, True, True)
        servers = [upstream, frontend]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            payload = b'{"operationId":"same-on-retry"}'

            for offline in (False, True, False):
                (frontend.transport_offline.set if offline else frontend.transport_offline.clear)()
                for url in ('/index.html', '/books/room-for-stories.json', '/api/v1/auth/session'):
                    with self.subTest(offline=offline, url=url):
                        connection = http.client.HTTPConnection('127.0.0.1', frontend.server_port, timeout=3)
                        try:
                            connection.request('GET', url)
                            if offline:
                                with self.assertRaises(http.client.RemoteDisconnected):
                                    connection.getresponse()
                            else:
                                response = connection.getresponse()
                                response.read()
                        finally:
                            connection.close()

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
            path = '/api/v1/auth/verify'
            self.assertEqual(post(path), (200, b'{"committed":true}'))
            controls = JourneyControls([frontend], Mock())
            controls.execute('lose-verify a before-headers')
            with self.assertRaises(http.client.RemoteDisconnected):
                post(path)
            self.assertEqual(post(path), (200, b'{"committed":true}'))
            controls.execute('lose-verify a after-headers')
            connection = http.client.HTTPConnection('127.0.0.1', frontend.server_port, timeout=3)
            try:
                connection.request('POST', path, payload)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader('Set-Cookie'), 'session=test-only; HttpOnly; SameSite=Lax')
                with self.assertRaises(http.client.IncompleteRead):
                    response.read()
            finally:
                connection.close()
            self.assertEqual(received[-1], (path, payload))
            self.assertEqual(post(path), (200, b'{"committed":true}'))
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == '__main__':
    unittest.main()

import json
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from egress import PublicProxy, public_addresses, validate_url
from fetch_audio import fetch_audio, media_duration, run


class FetchTests(unittest.TestCase):
    def test_url_validation(self):
        for url in ['file:///etc/passwd', 'http://example.org/a', 'https://u:p@example.org/a', 'https://example.org:444/a', 'https://example.org/a\n', None]:
            with self.assertRaises(ValueError):
                validate_url(url)
        self.assertEqual(validate_url('https://example.org/a.mp3'), 'https://example.org/a.mp3')

    def test_dns_private_and_mixed_answers_are_rejected(self):
        for addresses in [['127.0.0.1'], ['169.254.169.254'], ['10.0.0.1'], ['::1'], ['::ffff:127.0.0.1'], ['8.8.8.8', '192.168.1.2']]:
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443)) for ip in addresses]
            with patch('socket.getaddrinfo', return_value=answers), self.assertRaises(ValueError):
                public_addresses('source.example')

    def test_proxy_does_not_connect_private_redirect_target(self):
        with PublicProxy(time.monotonic() + 5) as proxy:
            port = int(proxy.rsplit(':', 1)[1])
            with socket.create_connection(('127.0.0.1', port)) as client:
                client.sendall(b'CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n')
                self.assertEqual(client.recv(100), b'')

    def test_subprocess_is_killed_on_deadline(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, 'timed out'):
            run([sys.executable, '-c', 'import time; time.sleep(10)'], started + 0.05)
        self.assertLess(time.monotonic() - started, 2)

    def test_final_duration_is_checked_independently(self):
        with patch('fetch_audio.run', return_value=json.dumps({'format': {'duration': 'nan'}, 'streams': [{'codec_type': 'audio'}]}).encode()), self.assertRaises(ValueError):
            media_duration('source.wav', time.monotonic() + 1)

    def test_duration_input_cannot_widen_limits(self):
        for duration in [0, -1, 901, True, 1.5]:
            with self.assertRaises(ValueError):
                fetch_audio('https://example.org/audio.wav', '/tmp', duration)

    def test_duration_filter_failure_has_a_stable_error(self):
        with self.assertRaisesRegex(ValueError, "duration limit"):
            run([sys.executable, "-c", "import sys; sys.stderr.write('duration filter rejected'); sys.exit(1)"], time.monotonic() + 2)

    def test_progress_reports_validation_before_network(self):
        stages = []
        with self.assertRaises(ValueError):
            fetch_audio("file:///etc/passwd", "/tmp", progress=stages.append)
        self.assertEqual(stages, ["validating_source"])

    def test_decode_rejects_media_without_audio(self):
        with patch('fetch_audio.run', return_value=b'{"streams":[],"format":{"duration":"10"}}'), self.assertRaisesRegex(ValueError, 'no audio'):
            media_duration('source.mp4', time.monotonic() + 1)


if __name__ == '__main__':
    unittest.main()

"""Loopback HTTPS proxy: resolve once, reject non-public IPs, connect to that IP.

Every yt-dlp HTTPS request (including redirects and extracted media) crosses this
proxy. No authentication cookies, app tokens, or inherited proxy settings enter
its subprocess. Plain HTTP and non-443 tunnels are deliberately unsupported.
"""
import ipaddress
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


def validate_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('Paste a public HTTPS media link.')
    try:
        u = urlsplit(value)
        if (u.scheme != 'https' or not u.hostname or u.username or u.password
                or u.port not in (None, 443) or u.fragment
                or any(ord(c) < 33 or ord(c) == 127 for c in value)):
            raise ValueError()
    except ValueError:
        raise ValueError('Paste a public HTTPS media link.') from None
    return value


def public_addresses(host):
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses:
        raise ValueError('Source address is unavailable.')
    for _, _, _, _, address in addresses:
        ip = ipaddress.ip_address(address[0])
        # Also reject transition/mapped ranges, which can hide an IPv4 target.
        if (not ip.is_global or getattr(ip, 'ipv4_mapped', None)
                or getattr(ip, 'sixtofour', None) or getattr(ip, 'teredo', None)):
            raise ValueError('Private network sources are not supported.')
    return addresses


class PublicProxy:
    def __init__(self, deadline, max_bytes=125 * 1024 * 1024):
        self.deadline = deadline
        self.remaining = max_bytes
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            timeout = 10

            def log_message(self, *_):
                pass  # Never log URLs, query parameters, or credentials.

            def do_CONNECT(self):
                upstream = None
                try:
                    host, port = self.path.rsplit(':', 1)
                    host = host.strip('[]')
                    if port != '443' or not host or '@' in host:
                        raise ValueError('Only HTTPS is supported.')
                    addresses = public_addresses(host)
                    # Try vetted addresses, IPv4 first; a failed IPv6 route is
                    # not proof that the source itself is unavailable.
                    for family, kind, protocol, _, address in sorted(addresses, key=lambda row: row[0] != socket.AF_INET):
                        candidate = socket.socket(family, kind, protocol)
                        candidate.settimeout(min(10, max(0.1, owner.deadline - time.monotonic())))
                        try:
                            candidate.connect(address)  # No second DNS lookup.
                            upstream = candidate
                            break
                        except OSError:
                            candidate.close()
                    if upstream is None:
                        return
                    self.send_response(200)
                    self.end_headers()
                    sockets = [self.connection, upstream]
                    while time.monotonic() < owner.deadline:
                        ready, _, _ = select.select(sockets, [], [], 1)
                        for source in ready:
                            chunk = source.recv(65536)
                            if not chunk:
                                return
                            with owner.lock:
                                owner.remaining -= len(chunk)
                                if owner.remaining < 0:
                                    return
                            target = upstream if source is self.connection else self.connection
                            target.sendall(chunk)
                except (ValueError, OSError):
                    # Fail closed. A failed TLS tunnel is surfaced by yt-dlp.
                    return
                finally:
                    if upstream:
                        upstream.close()

            def do_GET(self):
                self.send_error(403, 'Only HTTPS is supported')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True

    def __enter__(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f'http://127.0.0.1:{self.server.server_port}'

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

"""Bounded URL acquisition and local-only audio normalization."""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
from egress import PublicProxy, validate_url

MAX_BYTES = 100 * 1024 * 1024
MAX_DURATION = 900
MAX_SECONDS = 180
DIRECT_EXTENSIONS = {'.mp3', '.wav', '.m4a', '.mp4', '.webm', '.ogg', '.oga', '.flac', '.aiff', '.aif'}


def run(command, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError('Audio import timed out.')
    # Do not pass provider credentials, user configs, cookies, or proxy envs.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG', 'SSL_CERT_FILE') if k in os.environ}
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        p = subprocess.Popen(command, stdout=stdout, stderr=stderr, env=env, start_new_session=True)
        try:
            p.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            raise ValueError('Audio import timed out.') from None
        if p.returncode:
            stderr.seek(0)
            diagnostic = stderr.read(64 * 1024).decode('utf-8', 'replace').lower()
            if 'sign in' in diagnostic or 'bot' in diagnostic or '403' in diagnostic:
                raise ValueError('Source blocked this import. Upload the original audio instead.')
            if 'unsupported url' in diagnostic:
                raise ValueError('This site is not supported. Use a direct audio link or upload a file.')
            if 'duration' in diagnostic and 'filter' in diagnostic:
                raise ValueError('Audio exceeds the selected duration limit.')
            raise ValueError('Source returned no usable audio. Try a direct audio link or upload a file.')
        stdout.seek(0)
        data = stdout.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('Source metadata is too large.')
        return data


def media_duration(path, deadline):
    info = json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                           '-show_format', '-show_streams', '-of', 'json', str(path)], deadline))
    if not any(s.get('codec_type') == 'audio' for s in info.get('streams', [])):
        raise ValueError('Source contains no audio track.')
    duration = float(info.get('format', {}).get('duration', 0))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Source has no finite audio duration.')
    return duration


def fetch_audio(url, output_dir, max_duration=MAX_DURATION, progress=None):
    report = progress or (lambda stage: None)
    report("validating_source")
    validate_url(url)
    if isinstance(max_duration, bool) or not isinstance(max_duration, int) or not 1 <= max_duration <= MAX_DURATION:
        raise ValueError('Duration limit must be between 1 and 900 seconds.')
    deadline = time.monotonic() + MAX_SECONDS
    with tempfile.TemporaryDirectory(prefix='url-source-') as scratch, PublicProxy(deadline) as proxy:
        extension = Path(urlsplit(url).path).suffix.lower()
        stdout = b''
        if extension in DIRECT_EXTENSIONS:
            report("downloading_audio")
            class Redirects(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, request, fp, code, message, headers, new_url):
                    validate_url(new_url)
                    return super().redirect_request(request, fp, code, message, headers, new_url)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': proxy}), Redirects())
            try:
                with opener.open(urllib.request.Request(url, headers={'User-Agent': 'StemSplitter-AudioImport/1.0'}), timeout=15) as response:
                    declared = response.headers.get('Content-Length')
                    if declared and int(declared) > MAX_BYTES:
                        raise ValueError('Audio is too large (max 100 MB).')
                    size = 0
                    with (Path(scratch) / ('source' + extension)).open('wb') as target:
                        while True:
                            if time.monotonic() >= deadline:
                                raise ValueError('Audio import timed out.')
                            chunk = response.read(65536)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > MAX_BYTES:
                                raise ValueError('Audio is too large (max 100 MB).')
                            target.write(chunk)
            except OSError:
                raise ValueError('Source download is temporarily unavailable.') from None
            stdout = json.dumps(Path(urlsplit(url).path).stem).encode()
        else:
            # Native downloader owns manifest requests; FFmpeg never fetches a URL.
            common = ['yt-dlp', '--ignore-config', '--no-plugin-dirs', '--no-cache-dir',
                      '--no-playlist', '--playlist-items', '1', '--socket-timeout', '15',
                      '--retries', '2', '--fragment-retries', '2', '--proxy', proxy,
                      '--js-runtimes', 'deno', '--downloader', 'native', '--fixup', 'never',
                      '-f', 'bestaudio[protocol=https]/bestaudio[protocol=m3u8_native]/bestaudio[protocol=http_dash_segments]/best[protocol=https]']
            report("reading_metadata")
            info = json.loads(run(common + ['--dump-single-json', '--skip-download', '--', url], deadline))
            if info.get('entries'):
                info = info['entries'][0]
            if info.get('is_live') or info.get('live_status') == 'is_live':
                raise ValueError('Live streams cannot be imported.')
            metadata_duration = float(info.get('duration') or 0)
            if math.isfinite(metadata_duration) and metadata_duration > max_duration:
                raise ValueError(f'Audio is longer than {max_duration // 60} minutes.')
            report("downloading_audio")
            stdout = run(common + ['--max-filesize', str(MAX_BYTES),
                        '--match-filter', f'!is_live & duration <=? {max_duration}',
                        '--print', 'after_move:%(title)j', '--no-simulate',
                        '-o', str(Path(scratch) / 'source.%(ext)s'), '--', url], deadline)
        files = [p for p in Path(scratch).glob('source.*') if p.suffix not in ('.part', '.ytdl')]
        if len(files) != 1 or not 1024 <= files[0].stat().st_size <= MAX_BYTES:
            raise ValueError('Source returned no usable audio or exceeds 100 MB.')
        report("validating_download")
        duration = media_duration(files[0], deadline)
        if duration > max_duration:
            raise ValueError(f'Audio is longer than {max_duration // 60} minutes.')
        output = Path(output_dir) / 'audio.m4a'
        report("converting_audio")
        run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
             '-i', str(files[0]), '-map', '0:a:0', '-vn', '-t', str(max_duration + 1),
             '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', str(output)], deadline)
        report("validating_output")
        duration = media_duration(output, deadline)
        if duration > max_duration or not 1024 <= output.stat().st_size <= MAX_BYTES:
            raise ValueError('Audio exceeds the import limits.')
        lines = stdout.decode('utf-8', 'replace').strip().splitlines()
        try:
            title = json.loads(lines[-1]) if lines else 'imported-audio'
        except (ValueError, IndexError):
            title = 'imported-audio'
        report("ready")
        return output, str(title)[:200], duration

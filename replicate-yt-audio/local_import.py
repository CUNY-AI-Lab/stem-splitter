"""Local first importer. Logs stages, never URLs, cookies, or credentials."""
import argparse
import json
from pathlib import Path
import sys
import time
from fetch_audio import fetch_audio


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--limit-minutes', type=int, choices=(5, 15), default=5,
                        help='Local operator setting; hosted limits come from verified identity.')
    args = parser.parse_args()
    started = time.monotonic()

    def event(stage, **fields):
        print(json.dumps({'stage': stage, 'elapsedSeconds': round(time.monotonic() - started, 2), **fields}), flush=True)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if (args.output_dir / 'audio.m4a').exists():
        event('failed', code='output_exists', message='Choose an empty output directory.')
        return 1
    try:
        output, title, duration = fetch_audio(args.url, args.output_dir,
                                            args.limit_minutes * 60, progress=event)
        event('complete', output=str(output.resolve()), durationSeconds=duration)
        return 0
    except (ValueError, OSError) as error:
        output = args.output_dir / 'audio.m4a'
        output.unlink(missing_ok=True)
        message = str(error) if isinstance(error, ValueError) else 'Local audio import failed.'
        code = 'duration_limit' if 'longer' in message or 'duration limit' in message else 'import_failed'
        event('failed', code=code, message=message)
        return 1


if __name__ == '__main__':
    sys.exit(main())

// Build acceptance only: inspect a local image and run setup with network disabled.
// A successful receipt establishes neither Replicate publication nor live import.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { findYouTubePinViolations } from '../scripts/lib/pin-check.mjs';

const [image, sourceCommit, outputPath] = process.argv.slice(2);
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/);
assert.equal(image, `stem-youtube-candidate:${sourceCommit}`);
assert.ok(outputPath, 'an evidence output path is required');

function docker(args, input) {
  return execFileSync('docker', args, {
    encoding: 'utf8', input, timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Read only the metadata needed for this receipt, rather than image env values.
const metadata = docker(['image', 'inspect', '--format', [
  '{{.Id}}', '{{.Os}}', '{{.Architecture}}',
  '{{index .Config.Labels "run.cog.version"}}',
  '{{index .Config.Labels "run.cog.openapi_schema"}}',
].join('\n'), image]).split('\n');
const [imageId, os, architecture, cogVersion, ...schemaLines] = metadata;
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
assert.equal(os, 'linux');
assert.equal(architecture, 'amd64');
assert.equal(cogVersion.replace(/^v/, ''), '0.23.0');
const schemaText = schemaLines.join('\n');
const schema = JSON.parse(schemaText);
// Cog's API schema version is independent of the CLI version in the image label.
assert.deepEqual(findYouTubePinViolations(schema), []);
assert.ok(!schema.components.schemas.Input.required.includes('max_duration'));
assert.equal(schema.components.schemas.Input.properties.max_duration.default, 900);
assert.equal(schema.components.schemas.Output.properties.audio.format, 'uri');

const smoke = JSON.parse(docker([
  'run', '--rm', '--network', 'none', '--read-only',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
  '--interactive', '--entrypoint', 'python', image, '-',
], `
import importlib.metadata
import json
import platform
import re
import subprocess
from predict import FORMAT_SELECTOR, Predictor
from yt_dlp import YoutubeDL

expected = {"yt-dlp": "2026.8.19", "yt-dlp-ejs": "0.8.0", "deno": "2.9.5"}
versions = {name: importlib.metadata.version(name) for name in expected}
assert versions == expected, "extractor package versions differ from the reviewed pins"
assert platform.python_version_tuple()[:2] == ("3", "11")

def version(command):
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=15)
    line = result.stdout.splitlines()[0]
    assert len(line) <= 300 and re.fullmatch(r"[ -~]+", line)
    return line

executables = {
    "yt-dlp": version(["yt-dlp", "--version"]),
    "deno": version(["deno", "--version"]),
    "ffmpeg": version(["ffmpeg", "-version"]),
    "ffprobe": version(["ffprobe", "-version"]),
}
assert executables["yt-dlp"] == "2026.08.19"
assert executables["deno"].startswith("deno 2.9.5 ")
assert executables["ffmpeg"].startswith("ffmpeg version ")
assert executables["ffprobe"].startswith("ffprobe version ")

def forbid_prediction(*args, **kwargs):
    raise AssertionError("the build smoke must not execute predictions")

Predictor.predict = forbid_prediction
Predictor().setup()

# Exercise the image's real yt-dlp selector with synthetic, already-extracted
# format metadata. No extractor, download, or provider prediction runs here.
formats = {
    "audio-m4a": {"format_id": "audio-m4a", "ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none"},
    "audio-webm": {"format_id": "audio-webm", "ext": "webm", "acodec": "opus", "vcodec": "none"},
    "muxed": {"format_id": "muxed", "ext": "mp4", "acodec": "mp4a.40.2", "vcodec": "avc1.42001E"},
}
format_selection = {}
with YoutubeDL({"quiet": True, "no_warnings": True, "cachedir": False, "check_formats": False}) as ydl:
    ydl.urlopen = forbid_prediction
    selector = ydl.build_format_selector(FORMAT_SELECTOR)
    for name, available, expected_id in (
        ("muxedOnly", ["muxed"], "muxed"),
        ("audioOnlyPreferred", ["audio-m4a", "audio-webm", "muxed"], "audio-m4a"),
        ("otherAudioPreferred", ["audio-webm", "muxed"], "audio-webm"),
    ):
        selected = ydl._select_formats([formats[key].copy() for key in available], selector)
        assert len(selected) == 1 and selected[0]["format_id"] == expected_id, name
        assert selected[0]["acodec"] != "none", name + " must contain audio"
        format_selection[name] = selected[0]["format_id"]
print(json.dumps({"python": platform.python_version(), "packages": versions,
                  "executables": executables, "setupPassed": True, "predictionCalls": 0,
                  "formatSelection": format_selection}))
`));
assert.equal(smoke.setupPassed, true);
assert.equal(smoke.predictionCalls, 0);
assert.deepEqual(smoke.formatSelection, {
  muxedOnly: 'muxed', audioOnlyPreferred: 'audio-m4a', otherAudioPreferred: 'audio-webm',
});
assert.deepEqual(Object.keys(smoke).sort(), ['executables', 'formatSelection', 'packages', 'predictionCalls', 'python', 'setupPassed']);

const evidence = {
  schemaVersion: 1,
  sourceCommit,
  imageId,
  platform: `${os}/${architecture}`,
  cogVersion,
  schemaSha256: createHash('sha256').update(schemaText).digest('hex'),
  contract: {
    requiredInputs: ['url'], optionalInputs: ['max_duration'], maximumDurationDefault: 900,
    requiredOutputs: ['audio', 'title', 'duration'], audioFormat: 'uri',
  },
  smoke,
  runtimeNetwork: 'none',
  imagePublished: false,
  liveImportVerified: false,
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Verified extractor image ${imageId}; setup and schema passed; prediction calls: 0.`);

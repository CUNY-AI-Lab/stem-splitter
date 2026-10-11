"""Free extractor fault fixtures; no YouTube/Replicate requests."""
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

# Cog is an image dependency; these tests exercise our code, not a Cog upload.
class Model:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
cog = types.ModuleType('cog')
cog.BaseModel = Model
cog.BasePredictor = object
cog.Input = lambda **kwargs: kwargs.get('default')
cog.Path = Path
sys.modules['cog'] = cog
spec = importlib.util.spec_from_file_location('predict', Path(__file__).with_name('predict.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ExtractorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(m, 'ROOT', Path(self.tmp.name))
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.addCleanup(self.tmp.cleanup)

    def fixture(self, failure=None, barrier=None):
        calls=[]
        def run(cmd, deadline=None, diagnostic=None):
            calls.append(cmd)
            if '-J' in cmd:
                if failure == 'denial': raise ValueError('source_denied')
                return json.dumps({'title':'Fixture','duration':12,'is_live':failure=='live'})
            if cmd[0]=='yt-dlp':
                target=cmd[cmd.index('-o')+1].replace('%(ext)s','m4a')
                if failure=='disk': raise OSError('disk full')
                Path(target).write_bytes(b'fixture' * 300)
                if barrier: barrier.wait(timeout=3)
                return ''
            if cmd[0]=='ffprobe': return json.dumps({'format':{'duration':0 if failure=='zero' else 12},'streams':[{'codec_type':'audio'}]})
            if failure=='decode': raise ValueError('invalid_audio_response')
            return ''
        return run,calls

    def test_urls_and_option_injection(self):
        for url in ['https://youtu.be/abcdefghijk','https://youtube.com/watch?v=abcdefghijk','https://music.youtube.com/watch?v=abcdefghijk','https://youtube.com/shorts/abcdefghijk','https://youtube.com/embed/abcdefghijk','https://youtube.com/live/abcdefghijk']:
            self.assertEqual(m.canonical_url(url),'https://www.youtube.com/watch?v=abcdefghijk')
        for url in ['--exec=evil','file:///etc/passwd','https://youtube.com.evil/watch?v=abcdefghijk','https://u:p@youtube.com/watch?v=abcdefghijk','https://youtube.com:88/watch?v=abcdefghijk','http://127.0.0.1/','https://youtube.com/playlist?list=abc']:
            with self.assertRaises(ValueError): m.canonical_url(url)

    def test_vimeo_urls_preserve_id_and_unlisted_hash(self):
        cases = {
            "https://vimeo.com/1084537": "https://vimeo.com/1084537",
            "https://www.vimeo.com/1084537?share=copy": "https://vimeo.com/1084537",
            "https://player.vimeo.com/video/1084537": "https://vimeo.com/1084537",
            "https://vimeo.com/1084537/abcd1234ef": "https://vimeo.com/1084537/abcd1234ef",
            "https://player.vimeo.com/video/1084537?h=abcd1234ef": "https://vimeo.com/1084537/abcd1234ef",
        }
        for url, canonical in cases.items():
            self.assertEqual(m.canonical_url(url), canonical)
            expected = "https://player.vimeo.com/video/1084537" + ("?h=abcd1234ef" if "abcd1234ef" in canonical else "")
            self.assertEqual(m.extraction_url(url), expected)
        for url in [
            "https://vimeo.com.evil/1084537", "https://vimeo.com@evil.test/1084537",
            "https://vimeo.com:8443/1084537", "https://vimeo.com/1084537/../../1",
            "https://vimeo.com/0", "https://vimeo.com/1234567890123", "https://vimeo.com/channels/1",
            "https://player.vimeo.com/1084537", "https://vimeo.com/1084537?h=",
            "https://vimeo.com/1084537?h=abcd1234ef&h=abcd1234ef",
            "https://vimeo.com/1084537/abcd1234ef?h=1234567890",
            "https://youtube.com/watch?v=abcdefghijk&v=12345678901",
            "file:///etc/passwd", "--exec=touch /tmp/fail", None,
            "https://vimeo.com/\n1084537", "https://vimeo.com/1084537\t", "https://vimeo.com/\\1084537",
        ]:
            with self.assertRaisesRegex(ValueError, "invalid_video_url"):
                m.canonical_url(url)

    def test_vimeo_uses_public_player_for_metadata_and_download(self):
        predictor = m.Predictor()
        run, calls = self.fixture()
        with patch.object(predictor, "_run", side_effect=run), redirect_stdout(io.StringIO()):
            result = predictor.predict("https://vimeo.com/1084537/abcd1234ef", 900)
        fetches = [cmd for cmd in calls if cmd[0] == "yt-dlp"]
        self.assertEqual(len(fetches), 2)
        self.assertTrue(all(cmd[-2:] == ["--", "https://player.vimeo.com/video/1084537?h=abcd1234ef"] for cmd in fetches))
        self.assertEqual(result.duration, 12)
        self.assertTrue(Path(result.audio).is_file())

    def test_vimeo_restrictions_stop_after_metadata(self):
        predictor = m.Predictor()
        with patch.object(predictor, "_run", side_effect=ValueError("source_denied_content_restricted")) as run, redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "source_denied_content_restricted"):
                predictor.predict("https://vimeo.com/1084537", 900)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(list(m.ROOT.iterdir()), [])
        self.assertEqual(m.failure_code("This format is DRM protected"), "source_denied_content_restricted")
        self.assertEqual(m.failure_code("Cannot download embed-only video without embedding URL"), "source_denied_content_restricted")
        self.assertEqual(m.failure_code("The web client only works when logged-in"), "source_denied_authentication")
        self.assertEqual(m.failure_code("This video is protected by a password, use the --video-password option"), "source_denied_authentication")

    def test_denial_live_disk_and_bad_media_leave_no_partial_outputs(self):
        for failure in ['denial','live','disk','zero','decode']:
            predictor=m.Predictor();run,calls=self.fixture(failure)
            with patch.object(predictor,'_run',side_effect=run):
                with self.assertRaises((ValueError,OSError)):predictor.predict('https://youtu.be/abcdefghijk',900)
            self.assertEqual(list(m.ROOT.iterdir()),[])
            if failure=='denial':self.assertEqual(len(calls),1)

    def test_concurrent_outputs_have_unique_paths_and_stale_restart_cleanup(self):
        barrier=threading.Barrier(2);outputs=[];errors=[]
        def invoke():
            predictor=m.Predictor();run,calls=self.fixture(barrier=barrier)
            try:
                with patch.object(predictor,'_run',side_effect=run):outputs.append(predictor.predict('https://youtu.be/abcdefghijk',900))
                for cmd in calls:
                    if cmd[0]=='yt-dlp':
                        self.assertEqual(cmd[-2],'--');self.assertIn('--retries',cmd);self.assertNotIn('--extractor-args',cmd)
            except BaseException as error:errors.append(error)
        threads=[threading.Thread(target=invoke) for _ in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(5)
        self.assertEqual(errors,[]);self.assertEqual(len(outputs),2);self.assertNotEqual(outputs[0].audio,outputs[1].audio)
        m.cleanup_stale(time.time()+3700);self.assertEqual(list(m.ROOT.iterdir()),[])

    def test_real_timeout_kills_child_process_and_missing_dependency_fails_closed(self):
        with self.assertRaisesRegex(ValueError,'timeout'):
            m.Predictor()._run([sys.executable,'-c','import time;time.sleep(20)'],time.monotonic()+.03)
        with patch.object(m.shutil,'which',return_value=None):
            with self.assertRaisesRegex(RuntimeError,'dependency'):m.Predictor().setup()

    def test_fixed_failure_codes_distinguish_access_from_extractor_compatibility(self):
        cases = [
            ("ERROR: Sign in to confirm you’re not a bot", "source_denied_bot_verification"),
            ("ERROR: CAPTCHA verification required", "source_denied_bot_verification"),
            ("ERROR: Sign in to watch this video", "source_denied_authentication"),
            ("ERROR: Authentication is required", "source_denied_authentication"),
            ("ERROR: Sign in to confirm your age", "source_denied_age_restricted"),
            ("ERROR: This video is age-restricted", "source_denied_age_restricted"),
            ("ERROR: Private video. Sign in if you have access", "source_denied_private"),
            ("ERROR: The uploader has not made this video available in your country", "source_denied_geo_restricted"),
            ("ERROR: This video has been removed by the uploader", "source_denied_content_restricted"),
            ("ERROR: This video is DRM protected", "source_denied_content_restricted"),
            ("ERROR: This video is unavailable", "source_denied_content_restricted"),
            ("ERROR: HTTP Error 401: Unauthorized", "source_denied_http_401"),
            ("ERROR: HTTPError 403: Forbidden", "source_denied_http_403"),
            ("ERROR: HTTP status code: 429 Too Many Requests", "source_rate_limited"),
            ("ERROR: rate-limited", "source_rate_limited"),
            ("WARNING: n challenge solving failed: Some formats may be missing", "extractor_failed_js_runtime"),
            ("WARNING: nsig extraction failed", "extractor_failed_js_runtime"),
            ("WARNING: No supported JavaScript runtime could be found", "extractor_failed_js_runtime"),
            ("ERROR: EJS challenge solver failed", "extractor_failed_js_runtime"),
            ("ERROR: Deno executable not found", "extractor_failed_js_runtime"),
            ("ERROR: Requested format is not available", "extractor_failed_format_unavailable"),
            ("ERROR: No suitable audio format", "extractor_failed_format_unavailable"),
            ("ERROR: Unexpected extractor failure", "extractor_failed"),
            ("ERROR: unknown challenge at https://example.invalid/private/403?token=401429", "extractor_failed"),
            ("WARNING: n challenge solving failed\nERROR: Sign in to confirm you’re not a bot", "source_denied_bot_verification"),
            ("WARNING: No supported JavaScript runtime could be found\nERROR: HTTP Error 403: Forbidden", "source_denied_http_403"),
            ("WARNING: n challenge solving failed\nERROR: Requested format is not available", "extractor_failed_js_runtime"),
        ]
        for stderr, expected in cases:
            with self.subTest(stderr=stderr):
                self.assertEqual(m.failure_code(stderr), expected)

    def test_process_failure_exposes_only_fixed_code_and_access_stops_before_download(self):
        for diagnostic, expected in [
            ("n challenge solving failed", "extractor_failed_js_runtime"),
            ("Sign in to confirm you’re not a bot", "source_denied_bot_verification"),
        ]:
            stderr = diagnostic + " https://example.invalid/?token=private-fixture-value Authorization: Bearer fixture-secret"
            command = [sys.executable, '-c', 'import sys;sys.stderr.write(sys.argv[1]);sys.exit(1)', stderr]
            predictor=m.Predictor()
            with self.assertRaises(ValueError) as raised:
                predictor._run(command)
            self.assertEqual(str(raised.exception), expected)
            calls=[]
            def denied(cmd, deadline=None, diagnostic=None):
                calls.append(cmd)
                raise ValueError(expected)
            with patch.object(predictor,'_run',side_effect=denied):
                with self.assertRaisesRegex(ValueError,'^'+expected+'$'):
                    predictor.predict('https://youtu.be/abcdefghijk',900)
            self.assertEqual(len(calls),1)
            self.assertIn('-J',calls[0])
            self.assertEqual(list(m.ROOT.iterdir()),[])

    def test_metadata_restrictions_return_specific_codes_before_download(self):
        for metadata, expected in [
            ({'availability':'private'},'source_denied_private'),
            ({'availability':'premium_only'},'source_denied_content_restricted'),
            ({'availability':'subscriber_only'},'source_denied_content_restricted'),
            ({'availability':'needs_auth'},'source_denied_authentication'),
            ({'age_limit':18},'source_denied_age_restricted'),
        ]:
            predictor=m.Predictor()
            with patch.object(predictor,'_run',return_value=json.dumps({'duration':12,**metadata})) as run:
                with self.assertRaisesRegex(ValueError,'^'+expected+'$'):
                    predictor.predict('https://youtu.be/abcdefghijk',900)
                self.assertEqual(run.call_count,1)
            self.assertEqual(list(m.ROOT.iterdir()),[])

    def test_bounded_head_and_tail_preserve_final_failure_and_early_warning(self):
        warning = 'WARNING: n challenge solving failed\n'
        denial = "\nERROR: Sign in to confirm you're not a bot"
        stderr = warning + ('ordinary-progress ' * 5000) + denial
        with tempfile.TemporaryFile() as errors:
            errors.write(stderr.encode())
            captured = m.bounded_stderr(errors)
        self.assertLessEqual(len(captured.encode()), 64 * 1024)
        self.assertTrue(captured.startswith(warning))
        self.assertTrue(captured.endswith(denial))
        command = [sys.executable, '-c', 'import sys;sys.stderr.write(sys.argv[1]);sys.exit(1)', stderr]
        events = io.StringIO()
        with redirect_stdout(events):
            with self.assertRaisesRegex(ValueError, '^source_denied_bot_verification$'):
                with m.diagnostic_stage('download') as diagnostic:
                    m.Predictor()._run(command, diagnostic=diagnostic)
        event = json.loads(events.getvalue())
        self.assertEqual(event['code'], 'source_denied_bot_verification')
        self.assertEqual(event['warningCode'], 'extractor_failed_js_runtime')
        self.assertEqual(event['status'], 'failed')
        self.assertEqual(event['stage'], 'download')

    def test_successful_stage_reports_js_warning_without_private_values(self):
        private = ' https://private.invalid/?token=fixture-secret Cookie: fixture-cookie Authorization: fixture-header title=fixture-title'
        command = [sys.executable, '-c', 'import sys;sys.stdout.write("unchanged-output");sys.stderr.write(sys.argv[1])',
                   'WARNING: No supported JavaScript runtime could be found' + private]
        events = io.StringIO()
        with redirect_stdout(events):
            with m.diagnostic_stage('metadata') as diagnostic:
                result = m.Predictor()._run(command, diagnostic=diagnostic)
        self.assertEqual(result, 'unchanged-output')
        event = json.loads(events.getvalue())
        self.assertEqual(set(event), {'event', 'stage', 'status', 'elapsedMs', 'code', 'warningCode'})
        self.assertEqual(event['status'], 'succeeded')
        self.assertEqual(event['code'], 'ok')
        self.assertEqual(event['warningCode'], 'extractor_failed_js_runtime')
        self.assertIsInstance(event['elapsedMs'], int)
        self.assertGreaterEqual(event['elapsedMs'], 0)
        for secret in ('private.invalid', 'fixture-secret', 'fixture-cookie', 'fixture-header', 'fixture-title', 'unchanged-output'):
            self.assertNotIn(secret, events.getvalue())

    def test_prediction_stage_events_cover_success_and_preserve_output(self):
        predictor=m.Predictor();run,_=self.fixture();events=io.StringIO()
        with redirect_stdout(events), patch.object(predictor,'_run',side_effect=run):
            output=predictor.predict('https://youtu.be/abcdefghijk',900)
        parsed=[json.loads(line) for line in events.getvalue().splitlines()]
        self.assertEqual([event['stage'] for event in parsed], ['metadata','download','probe','decode'])
        for event in parsed:
            self.assertEqual(set(event), {'event','stage','status','elapsedMs','code'})
            self.assertEqual(event['event'],'extractor_stage')
            self.assertEqual((event['status'],event['code']),('succeeded','ok'))
        self.assertEqual((output.title,output.duration),('Fixture',12))
        self.assertEqual(Path(output.audio).read_bytes(),b'fixture'*300)

    def test_validation_and_arbitrary_failures_have_safe_stage_events(self):
        for failure,stage,code in [('denial','metadata','source_denied'),('live','metadata','live_stream'),
                                   ('disk','download','extractor_failed'),('zero','probe','invalid_audio_response'),
                                   ('decode','decode','invalid_audio_response')]:
            predictor=m.Predictor();run,_=self.fixture(failure);events=io.StringIO()
            with redirect_stdout(events), patch.object(predictor,'_run',side_effect=run):
                with self.assertRaises((ValueError,OSError)):
                    predictor.predict('https://youtu.be/abcdefghijk',900)
            parsed=[json.loads(line) for line in events.getvalue().splitlines()]
            self.assertEqual((parsed[-1]['stage'],parsed[-1]['status'],parsed[-1]['code']),(stage,'failed',code))
            self.assertEqual(list(m.ROOT.iterdir()),[])
        private=OSError('Cookie: fixture-cookie https://private.invalid/?token=fixture-secret')
        events=io.StringIO()
        with redirect_stdout(events):
            with self.assertRaises(OSError) as raised:
                with m.diagnostic_stage('download'):
                    raise private
        self.assertIs(raised.exception,private)
        self.assertEqual(json.loads(events.getvalue())['code'],'extractor_failed')
        self.assertNotIn('fixture-',events.getvalue())
        self.assertNotIn('private.invalid',events.getvalue())

if __name__=='__main__':unittest.main()

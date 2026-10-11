"""Free extractor fault fixtures; no YouTube/Replicate requests."""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
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
        def run(cmd, deadline=None):
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
            def denied(cmd, deadline=None):
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

if __name__=='__main__':unittest.main()

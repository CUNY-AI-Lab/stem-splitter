"""Idempotency of the YouTube fetcher: YouTube is asked once per video, with yt-dlp faked."""
import hashlib
import json
import os
import pathlib
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

os.environ.setdefault("YT_FETCHER_SECRET", "s" * 40)
import fetcher  # noqa: E402

GUEST, MEMBER = 300, 900


class FakeYouTube:
    """Stands in for yt_dlp.YoutubeDL and counts what would have reached YouTube."""
    videos, asked, downloads, searches, listing = {}, 0, 0, 0, []
    guard = threading.Lock()

    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def extract_info(self, url, download=False):
        if url.startswith("ytsearch"):
            with FakeYouTube.guard:
                FakeYouTube.searches += 1
            return {"entries": FakeYouTube.listing}
        video_id = url.rsplit("=", 1)[1]
        with FakeYouTube.guard:
            FakeYouTube.asked += 1
        video = FakeYouTube.videos[video_id]
        if video.get("error"):
            raise fetcher.yt_dlp.utils.DownloadError(video["error"])
        return {"id": video_id, "title": video.get("title", "Fixture song"), "duration": video["duration"],
                "live_status": "is_live" if video.get("live") else "not_live"}

    def process_ie_result(self, info, download=True):
        with FakeYouTube.guard:
            FakeYouTube.downloads += 1
        video = FakeYouTube.videos[info["id"]]
        time.sleep(video.get("delay", 0))
        path = pathlib.Path(self.options["outtmpl"].replace("%(ext)s", "m4a"))
        path.write_bytes(video.get("audio", b"\x00\x00\x00\x18ftyp" + info["id"].encode()))


class FetcherIdempotency(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        fetcher.CACHE = pathlib.Path(self.folder.name) / "cache"
        fetcher._locks.clear()
        fetcher.yt_dlp.YoutubeDL = FakeYouTube
        FakeYouTube.videos, FakeYouTube.asked, FakeYouTube.downloads, FakeYouTube.searches = {}, 0, 0, 0
        FakeYouTube.listing = []
        fetcher._searches.clear()
        fetcher.BUDGET = fetcher.Budget(fetcher.HOURLY_REQUESTS)
        fetcher.VIDEO_GAP_SECONDS = 0

    def tearDown(self):
        self.folder.cleanup()

    def test_the_hour_stays_under_youtubes_rate_and_keeps_room_for_imports(self):
        budget = fetcher.Budget(24)  # Searches may use 8 of it.
        for _ in range(4):
            budget.take("search", fetcher.SEARCH_COST)
        with self.assertRaises(fetcher.Refused) as searches_full:
            budget.take("search", fetcher.SEARCH_COST)
        self.assertEqual((searches_full.exception.code, searches_full.exception.status), ("hourly_budget", 429))
        for _ in range(4):
            budget.take("video", fetcher.VIDEO_COST)  # Imports still fit: 8 + 16 = 24.
        with self.assertRaises(fetcher.Refused):
            budget.take("video", fetcher.VIDEO_COST)
        budget.spent[0] = (time.time() - 3600, *budget.spent[0][1:])  # An hour later the oldest is free again.
        budget.take("search", fetcher.SEARCH_COST)
        self.assertEqual(budget.used(), 24)

    def test_the_documented_rate_sets_the_default(self):
        # yt-dlp wiki: a guest session gets about 1000 webpage/player requests (300 videos) an hour.
        self.assertLessEqual(fetcher.HOURLY_REQUESTS, 1000 * 0.6)
        self.assertGreaterEqual(fetcher.VIDEO_COST, 1000 / 300)

    def test_cached_answers_cost_nothing_and_a_full_hour_asks_youtube_nothing(self):
        FakeYouTube.videos["mmmmmmmmmmm"] = {"duration": 200}
        FakeYouTube.listing = [{"id": "mmmmmmmmmmm", "title": "Song", "channel": "C", "duration": 200}]
        fetcher.fetch("mmmmmmmmmmm", MEMBER)
        fetcher.search("song")
        spent = fetcher.BUDGET.used()
        self.assertEqual(spent, fetcher.VIDEO_COST + fetcher.SEARCH_COST)
        self.assertEqual(fetcher.fetch("mmmmmmmmmmm", MEMBER)[2], "hit")
        self.assertEqual(fetcher.search("Song")[1], "hit")
        self.assertEqual(fetcher.BUDGET.used(), spent)
        fetcher.BUDGET = fetcher.Budget(0)
        FakeYouTube.videos["nnnnnnnnnnn"] = {"duration": 200}
        for attempt in (lambda: fetcher.fetch("nnnnnnnnnnn", MEMBER), lambda: fetcher.search("another song")):
            with self.assertRaises(fetcher.Refused) as full:
                attempt()
            self.assertEqual(full.exception.code, "hourly_budget")
        self.assertEqual((FakeYouTube.asked, FakeYouTube.searches), (1, 1))
        self.assertIsNone(fetcher.recall(fetcher.entry_name("nnnnnnnnnnn"))[0], "a full hour is not remembered as a refusal")

    def test_video_lookups_start_apart(self):
        fetcher.VIDEO_GAP_SECONDS = 0.3
        FakeYouTube.videos.update({"ooooooooooo": {"duration": 200}, "ppppppppppp": {"duration": 200}})
        started = time.monotonic()
        fetcher.fetch("ooooooooooo", MEMBER)
        fetcher.fetch("ppppppppppp", MEMBER)
        self.assertGreaterEqual(time.monotonic() - started, 0.3)

    def test_a_second_request_is_served_from_the_first_download(self):
        FakeYouTube.videos["aaaaaaaaaaa"] = {"duration": 200}
        first = fetcher.fetch("aaaaaaaaaaa", MEMBER)
        second = fetcher.fetch("aaaaaaaaaaa", GUEST)
        self.assertEqual((first[2], second[2]), ("miss", "hit"))
        self.assertEqual(first[1], second[1])
        self.assertEqual(second[0]["sha256"], hashlib.sha256(second[1]).hexdigest())
        self.assertEqual((FakeYouTube.asked, FakeYouTube.downloads), (1, 1))

    def test_simultaneous_requests_for_one_video_download_it_once(self):
        FakeYouTube.videos["bbbbbbbbbbb"] = {"duration": 200, "delay": 0.3}
        results = []
        threads = [threading.Thread(target=lambda: results.append(fetcher.fetch("bbbbbbbbbbb", MEMBER))) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 5)
        self.assertEqual(sorted(result[2] for result in results), ["hit"] * 4 + ["miss"])
        self.assertEqual(len({result[1] for result in results}), 1)
        self.assertEqual(FakeYouTube.downloads, 1)

    def test_a_video_too_long_for_a_guest_is_not_downloaded_and_its_length_is_remembered(self):
        FakeYouTube.videos["ccccccccccc"] = {"duration": 400}
        for _ in range(2):
            with self.assertRaises(fetcher.Refused) as refused:
                fetcher.fetch("ccccccccccc", GUEST)
            self.assertEqual(refused.exception.code, "source_too_long")
        self.assertEqual((FakeYouTube.asked, FakeYouTube.downloads), (1, 0))
        # A member may import it: it is downloaded once, then reused.
        self.assertEqual(fetcher.fetch("ccccccccccc", MEMBER)[2], "miss")
        self.assertEqual(fetcher.fetch("ccccccccccc", MEMBER)[2], "hit")
        self.assertEqual(FakeYouTube.downloads, 1)

    def test_final_refusals_are_remembered_for_an_hour(self):
        FakeYouTube.videos["ddddddddddd"] = {"duration": 200, "error": "ERROR: [youtube] ddddddddddd: Private video"}
        for _ in range(3):
            with self.assertRaises(fetcher.Refused) as refused:
                fetcher.fetch("ddddddddddd", MEMBER)
            self.assertEqual(refused.exception.code, "source_denied_private")
        self.assertEqual(FakeYouTube.asked, 1)
        record = fetcher.CACHE / f"{fetcher.entry_name('ddddddddddd')}.json"
        stored = json.loads(record.read_text())
        record.write_text(json.dumps({**stored, "stored": time.time() - fetcher.REFUSAL_SECONDS - 1}))
        with self.assertRaises(fetcher.Refused):
            fetcher.fetch("ddddddddddd", MEMBER)
        self.assertEqual(FakeYouTube.asked, 2)

    def test_a_bot_check_is_not_remembered(self):
        FakeYouTube.videos["eeeeeeeeeee"] = {"duration": 200, "error": "ERROR: Sign in to confirm you're not a bot"}
        for _ in range(2):
            with self.assertRaises(fetcher.Refused) as refused:
                fetcher.fetch("eeeeeeeeeee", MEMBER)
            self.assertEqual((refused.exception.code, refused.exception.status), ("source_denied_bot_verification", 503))
        self.assertEqual(FakeYouTube.asked, 2)

    def test_a_damaged_or_expired_download_is_fetched_again(self):
        FakeYouTube.videos["fffffffffff"] = {"duration": 200}
        fetcher.fetch("fffffffffff", MEMBER)
        name = fetcher.entry_name("fffffffffff")
        (fetcher.CACHE / f"{name}.audio").write_bytes(b"damaged")
        self.assertEqual(fetcher.fetch("fffffffffff", MEMBER)[2], "miss")
        record = fetcher.CACHE / f"{name}.json"
        record.write_text(json.dumps({**json.loads(record.read_text()), "stored": time.time() - fetcher.AUDIO_SECONDS - 1}))
        self.assertEqual(fetcher.fetch("fffffffffff", MEMBER)[2], "miss")
        self.assertEqual(FakeYouTube.downloads, 3)

    def test_the_cache_stays_under_its_size_by_dropping_the_least_recently_used(self):
        original = fetcher.CACHE_BYTES
        fetcher.CACHE_BYTES = 2500
        try:
            for index, video_id in enumerate(["ggggggggggg", "hhhhhhhhhhh", "iiiiiiiiiii"]):
                FakeYouTube.videos[video_id] = {"duration": 200, "audio": bytes([index]) * 1000}
                fetcher.fetch(video_id, MEMBER)
                time.sleep(0.02)
            self.assertLessEqual(sum(path.stat().st_size for path in fetcher.CACHE.glob("*.audio")), 2500)
            self.assertEqual(fetcher.fetch("ggggggggggg", MEMBER)[2], "miss")
            self.assertEqual(fetcher.fetch("iiiiiiiiiii", MEMBER)[2], "hit")
        finally:
            fetcher.CACHE_BYTES = original

    def test_the_cache_folder_does_not_name_the_videos(self):
        FakeYouTube.videos["jjjjjjjjjjj"] = {"duration": 200}
        fetcher.fetch("jjjjjjjjjjj", MEMBER)
        names = " ".join(path.name for path in fetcher.CACHE.iterdir())
        self.assertNotIn("jjjjjjjjjjj", names)
        self.assertNotIn("jjjjjjjjjjj", " ".join(path.read_text() for path in fetcher.CACHE.glob("*.json")))

    def test_a_failure_that_is_not_a_refusal_gets_one_more_try(self):
        FakeYouTube.videos["lllllllllll"] = {"duration": 200, "error": "ERROR: Unable to download webpage: timed out"}
        original = fetcher.RETRY_PAUSE_SECONDS
        fetcher.RETRY_PAUSE_SECONDS = 0
        try:
            with self.assertRaises(fetcher.Refused) as refused:
                fetcher.fetch("lllllllllll", MEMBER)
            self.assertEqual(refused.exception.code, "extractor_failed")
            self.assertEqual(FakeYouTube.asked, 2)
            FakeYouTube.videos["lllllllllll"] = {"duration": 200}
            self.assertEqual(fetcher.fetch("lllllllllll", MEMBER)[2], "miss")
        finally:
            fetcher.RETRY_PAUSE_SECONDS = original

    def test_requests_wait_in_a_bounded_line_and_beyond_it_are_told_to_come_back(self):
        originals = fetcher.SLOTS, fetcher.MAX_WAITING, fetcher.SLOT_WAIT_SECONDS
        fetcher.SLOTS, fetcher.MAX_WAITING, fetcher.SLOT_WAIT_SECONDS = threading.BoundedSemaphore(1), 1, 5
        try:
            for video_id in ["mmmmmmmmmmm", "nnnnnnnnnnn", "ooooooooooo"]:
                FakeYouTube.videos[video_id] = {"duration": 200, "delay": 0.4}
            outcomes = {}
            def run(video_id):
                try:
                    outcomes[video_id] = fetcher.fetch(video_id, MEMBER)[2]
                except fetcher.Refused as refused:
                    outcomes[video_id] = refused.code
            first = threading.Thread(target=run, args=("mmmmmmmmmmm",)); first.start(); time.sleep(0.1)
            second = threading.Thread(target=run, args=("nnnnnnnnnnn",)); second.start(); time.sleep(0.1)
            run("ooooooooooo")  # The line holds one: this one is turned away at once.
            first.join(); second.join()
            self.assertEqual(outcomes, {"mmmmmmmmmmm": "miss", "nnnnnnnnnnn": "miss", "ooooooooooo": "fetcher_busy"})
        finally:
            fetcher.SLOTS, fetcher.MAX_WAITING, fetcher.SLOT_WAIT_SECONDS = originals

    def test_a_search_lists_valid_videos_and_is_reused_for_ten_minutes(self):
        FakeYouTube.listing = [
            {"id": "Yxep-gS-Btg", "title": "Rydeen", "channel": "Fixture Channel", "duration": 259},
            {"id": "UC1234567890abcdefghijkl", "title": "A channel"},
            {"id": "aaaaaaaaaaa", "title": "Live now", "uploader": "Fixture", "live_status": "is_live"},
        ]
        results, cache = fetcher.search("Rydeen")
        self.assertEqual(cache, "miss")
        self.assertEqual(results, [
            {"id": "Yxep-gS-Btg", "title": "Rydeen", "channel": "Fixture Channel", "duration": 259, "live": False},
            {"id": "aaaaaaaaaaa", "title": "Live now", "channel": "Fixture", "duration": None, "live": True}])
        self.assertEqual(fetcher.search("rydeen")[1], "hit")
        self.assertEqual(FakeYouTube.searches, 1)
        key = next(iter(fetcher._searches))
        fetcher._searches[key] = (time.time() - fetcher.SEARCH_SECONDS - 1, [])
        self.assertEqual(fetcher.search("Rydeen")[1], "miss")
        self.assertEqual(FakeYouTube.searches, 2)

    def test_http_answers_carry_the_checksum_and_cache_outcome(self):
        FakeYouTube.videos["kkkkkkkkkkk"] = {"duration": 200}
        server = ThreadingHTTPServer(("127.0.0.1", 0), fetcher.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def post():
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/audio", method="POST",
                    data=json.dumps({"videoId": "kkkkkkkkkkk", "maxSeconds": MEMBER}).encode(),
                    headers={"Authorization": "Bearer " + fetcher.SECRETS[0].decode(), "Content-Type": "application/json"})
                with urllib.request.urlopen(request) as response:
                    return response.headers, response.read()
            first, body = post()
            second, again = post()
            self.assertEqual((first["X-Fetcher-Cache"], second["X-Fetcher-Cache"]), ("miss", "hit"))
            self.assertEqual(first["X-Audio-Sha256"], hashlib.sha256(body).hexdigest())
            self.assertEqual(body, again)
            self.assertEqual(FakeYouTube.downloads, 1)
            def search(query):
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/search", method="POST",
                    data=json.dumps({"query": query}).encode(),
                    headers={"Authorization": "Bearer " + fetcher.SECRETS[0].decode(), "Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as error:
                    return error.code, json.loads(error.read())
            FakeYouTube.listing = [{"id": "kkkkkkkkkkk", "title": "Song", "channel": "C", "duration": 200}]
            self.assertEqual(search("song")[1]["results"][0]["id"], "kkkkkkkkkkk")
            self.assertEqual(search("x"), (400, {"code": "invalid_request"}))
        finally:
            server.shutdown()
            server.server_close()


class FetcherSecrets(unittest.TestCase):
    """Each Worker has its own secret; anything else is refused before the body is read."""

    def setUp(self):
        self.saved = fetcher.SECRETS, fetcher.CACHE_KEY
        self.folder = tempfile.TemporaryDirectory()
        path = pathlib.Path(self.folder.name) / "secrets"
        path.write_text("# dev\n" + "d" * 40 + "\n\n  # production\n" + "p" * 40 + "  \n")
        fetcher.SECRETS = tuple(fetcher.secret_lines(str(path)))
        fetcher.CACHE_KEY = b"k" * 40
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), fetcher.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        fetcher.SECRETS, fetcher.CACHE_KEY = self.saved
        self.folder.cleanup()

    def status(self, authorization):
        headers = {"Authorization": authorization} if authorization is not None else {}
        request = urllib.request.Request(f"http://127.0.0.1:{self.server.server_port}/healthz", headers=headers)
        try:
            with urllib.request.urlopen(request) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def test_the_file_gives_one_secret_per_line_without_comments_or_blanks(self):
        self.assertEqual(fetcher.SECRETS, (b"d" * 40, b"p" * 40))

    def test_each_workers_secret_is_accepted(self):
        self.assertEqual(self.status("Bearer " + "d" * 40), 200)
        self.assertEqual(self.status("Bearer " + "p" * 40), 200)

    def test_anything_else_is_refused(self):
        for attempt in (None, "", "Bearer ", "Bearer " + "d" * 39, "Bearer " + "d" * 41, "d" * 40,
                        "Bearer " + "d" * 40 + "p" * 40, "Bearer " + "k" * 40):
            self.assertEqual(self.status(attempt), 401, attempt)

    def test_cache_names_come_from_the_cache_key_so_rotating_a_secret_keeps_the_cache(self):
        before = fetcher.entry_name("aaaaaaaaaaa")
        fetcher.SECRETS = (b"n" * 40,)
        self.assertEqual(fetcher.entry_name("aaaaaaaaaaa"), before)
        fetcher.CACHE_KEY = b"j" * 40
        self.assertNotEqual(fetcher.entry_name("aaaaaaaaaaa"), before)


if __name__ == "__main__":
    unittest.main()

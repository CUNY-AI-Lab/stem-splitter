CREATE TABLE IF NOT EXISTS song_sample_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  settings TEXT CHECK(settings IS NULL OR json_valid(settings)),
  updated_by TEXT,
  updated_at TEXT
);
INSERT OR IGNORE INTO song_sample_settings (id, revision, settings, updated_by, updated_at) VALUES (1, 0, '{"enabled":true,"holdMs":3500,"cadenceMs":6000,"reshuffle":true,"tracks":[{"artist":"Bill Evans","title":"My Foolish Heart","archiveId":"riversidejazz","archiveFile":"01 Waltz For Debby - My Foolish Heart.mp3","genre":"jazz","durationSec":297.8,"verifiedAt":"2026-10-17T03:30:12.450Z","importTestedAt":"2026-10-17T03:30:12.450Z","importBytes":11913366},{"artist":"Yellow Magic Orchestra","title":"Behind the Mask","archiveId":"1979-yellow-magic-orchestra-solid-state-survivor","archiveFile":"05 - Behind The Mask.mp3","genre":"electronic","durationSec":217,"verifiedAt":"2026-10-17T03:30:14.881Z","importTestedAt":"2026-10-17T03:30:14.881Z","importBytes":5317073},{"artist":"Willie Nelson","title":"Stardust","archiveId":"willie-nelson-ride-me-back-home","archiveFile":"Willie Nelson Discografía completa FLAC/Willie Nelson - Stardust - 1978(1980) LP/01.Stardust.mp3","genre":"country","durationSec":234,"verifiedAt":"2026-10-17T03:30:17.838Z","importTestedAt":"2026-10-17T03:30:17.838Z","importBytes":5990236},{"artist":"Jorge Ben","title":"Ponta de Lança Africano","archiveId":"1976-jorge-ben-africa-brasil","archiveFile":"01 - Ponta de lança africano (Umbabarauma).mp3","genre":"funk","durationSec":229,"verifiedAt":"2026-10-17T03:30:23.660Z","importTestedAt":"2026-10-17T03:30:23.660Z","importBytes":6138821},{"artist":"David Bowie","title":"Sound and Vision","archiveId":"HUG055CD","archiveFile":"HUG055CD Here Comes the Night - 1990-03-04 Colisée de Québec, Québec City, Canada/Disc 2/202 Sound And Vision.mp3","genre":"rock","durationSec":213.84,"verifiedAt":"2026-10-17T03:30:26.980Z","importTestedAt":"2026-10-17T03:30:26.980Z","importBytes":4570381},{"artist":"Simon & Garfunkel","title":"The Sound of Silence","archiveId":"simon-garfunkel-sounds-of-silence-1966-2014_24-192","archiveFile":"01 - The Sound of Silence (Overdubbed Version).mp3","genre":"folk","durationSec":190.13,"verifiedAt":"2026-10-17T03:30:30.784Z","importTestedAt":"2026-10-17T03:30:30.784Z","importBytes":4483548}]}', 'system:verified-playlists', datetime('now'));
UPDATE song_sample_settings SET settings = '{"enabled":true,"holdMs":3500,"cadenceMs":6000,"reshuffle":true,"tracks":[{"artist":"Bill Evans","title":"My Foolish Heart","archiveId":"riversidejazz","archiveFile":"01 Waltz For Debby - My Foolish Heart.mp3","genre":"jazz","durationSec":297.8,"verifiedAt":"2026-10-17T03:30:12.450Z","importTestedAt":"2026-10-17T03:30:12.450Z","importBytes":11913366},{"artist":"Yellow Magic Orchestra","title":"Behind the Mask","archiveId":"1979-yellow-magic-orchestra-solid-state-survivor","archiveFile":"05 - Behind The Mask.mp3","genre":"electronic","durationSec":217,"verifiedAt":"2026-10-17T03:30:14.881Z","importTestedAt":"2026-10-17T03:30:14.881Z","importBytes":5317073},{"artist":"Willie Nelson","title":"Stardust","archiveId":"willie-nelson-ride-me-back-home","archiveFile":"Willie Nelson Discografía completa FLAC/Willie Nelson - Stardust - 1978(1980) LP/01.Stardust.mp3","genre":"country","durationSec":234,"verifiedAt":"2026-10-17T03:30:17.838Z","importTestedAt":"2026-10-17T03:30:17.838Z","importBytes":5990236},{"artist":"Jorge Ben","title":"Ponta de Lança Africano","archiveId":"1976-jorge-ben-africa-brasil","archiveFile":"01 - Ponta de lança africano (Umbabarauma).mp3","genre":"funk","durationSec":229,"verifiedAt":"2026-10-17T03:30:23.660Z","importTestedAt":"2026-10-17T03:30:23.660Z","importBytes":6138821},{"artist":"David Bowie","title":"Sound and Vision","archiveId":"HUG055CD","archiveFile":"HUG055CD Here Comes the Night - 1990-03-04 Colisée de Québec, Québec City, Canada/Disc 2/202 Sound And Vision.mp3","genre":"rock","durationSec":213.84,"verifiedAt":"2026-10-17T03:30:26.980Z","importTestedAt":"2026-10-17T03:30:26.980Z","importBytes":4570381},{"artist":"Simon & Garfunkel","title":"The Sound of Silence","archiveId":"simon-garfunkel-sounds-of-silence-1966-2014_24-192","archiveFile":"01 - The Sound of Silence (Overdubbed Version).mp3","genre":"folk","durationSec":190.13,"verifiedAt":"2026-10-17T03:30:30.784Z","importTestedAt":"2026-10-17T03:30:30.784Z","importBytes":4483548}]}', updated_by = 'system:verified-playlists', updated_at = datetime('now') WHERE id = 1 AND settings IS NULL AND revision = 0;
CREATE TABLE IF NOT EXISTS song_sample_revisions (
  revision INTEGER PRIMARY KEY CHECK(revision > 0),
  settings TEXT NOT NULL CHECK(json_valid(settings)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS song_sample_revisions_no_update BEFORE UPDATE ON song_sample_revisions
BEGIN
  SELECT RAISE(ABORT, 'song sample history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS song_sample_revisions_no_delete BEFORE DELETE ON song_sample_revisions
BEGIN
  SELECT RAISE(ABORT, 'song sample history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS song_sample_revisions_no_replace BEFORE INSERT ON song_sample_revisions WHEN EXISTS(SELECT 1 FROM song_sample_revisions WHERE revision = NEW.revision)
BEGIN
  SELECT RAISE(ABORT, 'song sample history is immutable');
END;

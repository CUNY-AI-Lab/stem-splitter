const audio = document.getElementById('station-audio');
const nowPlaying = document.getElementById('station-now-playing');
const playbackStatus = document.getElementById('station-playback-status');
const playlists = document.getElementById('station-playlists');
let selected = null;
let generation = 0;
function sourceUrl(value, download = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'archive.org' || url.username || url.password ||
      !url.pathname.startsWith(download ? '/download/' : '/details/')) throw new Error('Invalid Archive source');
  return url.href;
}
async function playSong(group, index, button) {
  const request = ++generation;
  const track = group.tracks[index];
  selected = { group, index };
  for (const control of playlists.querySelectorAll('[aria-pressed]')) control.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-pressed', 'true');
  nowPlaying.textContent = `${track.artist} — ${track.title}`;
  playbackStatus.textContent = 'Loading song…';
  audio.src = sourceUrl(track.audioUrl, true);
  try { await audio.play(); }
  catch { if (request === generation) playbackStatus.textContent = 'Playback could not start. Try Play again or open the Archive source.'; }
}
audio.addEventListener('playing', () => { playbackStatus.textContent = 'Playing'; });
audio.addEventListener('waiting', () => { playbackStatus.textContent = 'Buffering…'; });
audio.addEventListener('error', () => { playbackStatus.textContent = 'This recording is unavailable right now. Choose another song or open its Archive source.'; });
audio.addEventListener('pause', () => { if (!audio.ended && !audio.error) playbackStatus.textContent = 'Paused'; });
audio.addEventListener('ended', () => {
  if (selected && selected.index + 1 < selected.group.tracks.length) {
    const next = selected.index + 1;
    void playSong(selected.group, next, selected.group.buttons[next]);
  } else playbackStatus.textContent = 'Playlist finished.';
});
(async () => {
  try {
    const response = await fetch('/sound-stations.json');
    if (!response.ok) throw new Error('Playlist unavailable');
    const data = await response.json();
    for (const group of data.playlists) {
      const section = document.createElement('section');
      section.className = 'sound-station-group';
      const heading = document.createElement('h2'); heading.textContent = group.title;
      const credit = document.createElement('p'); credit.className = 'account-help'; credit.textContent = `Selected by ${group.curator}`;
      const list = document.createElement('ol'); group.buttons = [];
      for (const [index, track] of group.tracks.entries()) {
        sourceUrl(track.audioUrl, true);
        const row = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'station-song';
        button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', `Play ${track.title} by ${track.artist}`);
        const title = document.createElement('strong'); title.textContent = track.title;
        const artist = document.createElement('span'); artist.textContent = track.artist;
        const album = document.createElement('small'); album.textContent = track.album;
        button.append(title, artist, album);
        button.addEventListener('click', () => void playSong(group, index, button));
        const source = document.createElement('a'); source.href = sourceUrl(track.sourceUrl); source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Archive source';
        row.append(button, source); list.append(row); group.buttons.push(button);
      }
      section.append(heading, credit, list); playlists.append(section);
    }
    document.getElementById('station-loading').hidden = true;
  } catch { document.getElementById('station-loading').textContent = 'Playlists could not load. Reload to try again.'; }
})();

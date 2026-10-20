/* A live class is an explicit overlay on an already-authorized course split.
 * Personal recordings and public audio-only links never enter this path. */
(() => {
  'use strict';
  const POLL_MS = 2500;
  const HEARTBEAT_MS = 30000;
  const DRIFT_SECONDS = .35;
  const controlled = '.play-btn, .seek, .rate-opt, .solo-btn, .loop-clear, .note-loop, .note-time, .marker';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const controllers = new Set();

  class ClassSession {
    constructor(mixer) {
      this.mixer = mixer;
      this.url = `/api/classroom/courses/${encodeURIComponent(mixer.job.courseId)}/jobs/${encodeURIComponent(mixer.job.id)}/live`;
      this.session = null;
      this.revision = 0;
      this.canControl = false;
      this.isHost = false;
      this.leading = false;
      this.following = false;
      this.internal = 0;
      this.offset = 0;
      this.generation = 0;
      this.ready = false;
      this.pending = false;
      this.message = 'Class listening is independent unless you choose to follow an instructor.';
      this.disabled = new Map();
      this.original = {};
      this.lastFocus = JSON.stringify(mixer.soloState);
      this.makeControls();
      this.wrapMixer();
      this.keyHandler = event => {
        if (!this.following || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target;
        if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if (['Space', 'ArrowLeft', 'ArrowRight', 'BracketLeft', 'BracketRight', 'KeyL', 'Escape'].includes(event.code) || (event.shiftKey && /^Digit[1-9]$/.test(event.code))) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      };
      mixer.el.addEventListener('keydown', this.keyHandler, true);
      this.metadataHandler = () => { if (this.following) void this.apply(); };
      mixer.audios.forEach(audio => audio.addEventListener('loadedmetadata', this.metadataHandler));
      this.visibilityHandler = () => {
        clearTimeout(this.pollTimer);
        if (document.hidden) {
          // A hidden tab cannot keep renewing authority or make reliable cues.
          this.pauseLocally();
          if (this.following) this.audioBlocked = true;
          if (this.leading) {
            this.publishFinalPause();
            this.leading = false;
            this.message = 'Class leadership paused while this page is hidden. Resume class session when you return.';
          }
          this.render();
        } else { void this.read(); }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      controllers.add(this);
      // build() returns a detached element; the next task runs after insertion.
      this.pollTimer = setTimeout(() => void this.read(), 0);
    }

    makeControls() {
      const bar = document.createElement('div');
      bar.className = 'class-live';
      bar.setAttribute('aria-label', 'Class listening session');
      bar.style.cssText = 'margin:.75rem 0;padding:.65rem;border:1px solid var(--line,#777)';
      const status = document.createElement('p');
      status.className = 'class-live-status';
      status.setAttribute('role', 'status');
      status.style.cssText = 'flex-basis:100%;margin:0;font-size:.9rem';
      bar.append(status);
      const button = (name, action, className) => {
        const node = document.createElement('button');
        node.type = 'button'; node.className = `head-btn ${className}`; node.textContent = name;
        node.style.cssText = 'margin:.4rem .5rem 0 0;white-space:normal;text-align:left';
        node.addEventListener('click', action); bar.append(node); return node;
      };
      this.startButton = button('Start class session', () => void this.start(), 'class-live-start');
      this.endButton = button('End class session', () => void this.end(), 'class-live-end');
      this.followButton = button('Follow instructor', () => void this.follow(), 'class-live-follow');
      this.leaveButton = button('Leave class session', () => this.leave(), 'class-live-leave');
      this.joinButton = button('Join class audio', () => void this.joinAudio(), 'class-live-join');
      this.retryButton = button('Retry class connection', () => void this.read(), 'class-live-retry');
      this.bar = bar; this.status = status;
      this.mixer.el.querySelector('.transport').before(bar);
      this.render();
    }

    wrapMixer() {
      const mixer = this.mixer;
      const remember = name => { this.original[name] = mixer[name].bind(mixer); };
      for (const name of ['play', 'pause', 'stopUi', 'seekTo', 'setRate', 'setLoop', 'cycleSolo', 'applyMix', 'tick', 'disposeWaveforms', 'paintSeekControl', 'renderNotes', 'renderMarkers']) remember(name);
      for (const name of ['seekTo', 'setRate', 'setLoop', 'cycleSolo']) {
        mixer[name] = (...args) => {
          if (this.following && !this.internal) return;
          const result = this.original[name](...args);
          if (!this.internal) this.queueUpdate();
          return result;
        };
      }
      mixer.play = async (...args) => {
        if (this.following && !this.internal) return;
        const wasInternal = this.internal > 0;
        const result = await this.original.play(...args);
        if (!wasInternal) this.queueUpdate();
        return result;
      };
      mixer.pause = (...args) => {
        // Safety pauses (account checks, collapsed panel, stalled audio) always
        // work. A follower must explicitly rejoin after one of these pauses.
        if (this.following && !this.internal) {
          this.audioBlocked = true;
          this.message = 'Class audio paused on this device. Join class audio to continue.';
        }
        const result = this.original.pause(...args);
        if (!this.internal) this.queueUpdate();
        this.render();
        return result;
      };
      mixer.stopUi = (...args) => {
        const result = this.original.stopUi(...args);
        if (!this.internal) this.queueUpdate();
        return result;
      };
      mixer.tick = (...args) => this.inside(() => this.original.tick(...args));
      mixer.applyMix = (...args) => {
        if (this.following && this.session) mixer.soloState = this.focus();
        const result = this.original.applyMix(...args);
        // A class focus must not override a student's own mute switch.
        if (this.following && mixer.soloState && mixer.userMuted.get(mixer.soloState.stem)) {
          const channel = mixer.channelsByName.get(mixer.soloState.stem);
          if (channel) {
            channel.mixGain = 0;
            if (channel.gainNode) channel.gainNode.gain.value = 0;
            else channel.audio.muted = true;
            channel.row.classList.add('muted'); channel.muteBtn.setAttribute('aria-pressed', 'true');
          }
        }
        if (!this.internal && JSON.stringify(mixer.soloState) !== this.lastFocus) this.queueUpdate();
        this.lastFocus = JSON.stringify(mixer.soloState);
        return result;
      };
      for (const name of ['paintSeekControl', 'renderNotes', 'renderMarkers']) {
        mixer[name] = (...args) => { const result = this.original[name](...args); this.lockControls(); return result; };
      }
      mixer.disposeWaveforms = (...args) => { this.dispose(); return this.original.disposeWaveforms(...args); };
    }

    inside(run) { this.internal++; try { return run(); } finally { this.internal--; } }
    pauseLocally() { this.inside(() => this.original.pause()); }
    focus() { return this.session?.focusStem ? { stem: this.session.focusStem, stage: this.session.focusMode || 'only' } : null; }
    active() { return this.session?.active === true && this.session.expiresAt > Date.now() + this.offset; }
    usable() { return !this.disposed && !this.accessLost && !document.hidden && this.mixer.el.isConnected && !this.mixer.disposed; }

    lockControls() {
      for (const element of this.disabled.keys()) if (!element.isConnected) this.disabled.delete(element);
      for (const element of this.mixer.el.querySelectorAll(controlled)) {
        if (this.following) {
          if (!this.disabled.has(element)) this.disabled.set(element, element.disabled);
          element.disabled = true;
        } else if (this.disabled.has(element)) {
          element.disabled = this.disabled.get(element); this.disabled.delete(element);
        }
      }
      if (!this.following) this.disabled.clear();
    }

    render() {
      if (this.disposed) return;
      const active = this.active();
      this.status.textContent = this.message;
      this.startButton.hidden = !this.ready || !this.canControl || (active && !this.isHost) || this.leading;
      this.startButton.textContent = active && this.isHost ? 'Resume class session' : 'Start class session';
      this.endButton.hidden = !active || !this.isHost;
      this.followButton.hidden = !active || this.following || this.isHost;
      this.leaveButton.hidden = !this.following;
      this.joinButton.hidden = !this.following || !this.audioBlocked || !this.session?.playing;
      this.retryButton.hidden = !this.failed || this.accessLost;
      for (const button of [this.startButton, this.endButton, this.followButton, this.retryButton]) button.disabled = this.busy === true;
      this.bar.dataset.following = String(this.following);
      this.bar.dataset.leading = String(this.leading);
      this.lockControls();
    }

    snapshot() {
      const mixer = this.mixer;
      return {
        playing: mixer.playing === true,
        position: Math.min(900, Math.max(0, Number(mixer.audios[0]?.currentTime) || 0)),
        playbackRate: mixer.rate || 1,
        focusStem: mixer.soloState?.stem || null,
        focusMode: mixer.soloState?.stage || null,
        selection: mixer.loop ? { start: mixer.loop.start, end: mixer.loop.end } : null,
      };
    }

    async request(method = 'GET', body) {
      const began = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      this.abort = controller;
      try {
        const response = await fetch(this.url, {
          method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Stem-Course': this.mixer.job.courseId },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw Object.assign(new Error('Class connection unavailable.'), { status: response.status });
        const value = await response.json();
        if (!Number.isSafeInteger(value.revision) || !finite(value.serverTime) || typeof value.canControl !== 'boolean' || typeof value.isHost !== 'boolean') throw new Error('Invalid class session.');
        const session = value.session;
        if (session && (!Number.isSafeInteger(session.revision) || typeof session.active !== 'boolean' || typeof session.playing !== 'boolean' ||
          !finite(session.position) || session.position < 0 || session.position > 900 || !finite(session.playbackRate) || session.playbackRate < .5 || session.playbackRate > 2 ||
          !finite(session.updatedAt) || !finite(session.expiresAt) ||
          !(session.focusStem === null || this.mixer.channelsByName.has(session.focusStem)) ||
          !(session.focusStem === null ? session.focusMode === null : ['behind', 'only'].includes(session.focusMode)) ||
          !(session.selection === null || finite(session.selection?.start) && finite(session.selection?.end) && session.selection.start >= 0 && session.selection.end <= 900 && session.selection.end > session.selection.start))) throw new Error('Invalid class session.');
        this.offset = value.serverTime - (began + Date.now()) / 2;
        return value;
      } finally { clearTimeout(timer); if (this.abort === controller) this.abort = null; }
    }

    accept(value) {
      if (value.revision < this.revision) return;
      this.session = value.session;
      this.revision = value.revision;
      this.canControl = value.canControl;
      this.isHost = value.isHost;
      this.ready = true; this.failed = false; this.retryDelay = 0;
      if (this.concealed) {
        for (const [node, hidden] of this.concealed) if (node.isConnected) node.hidden = hidden;
        this.concealed = null;
      }
      if (this.leading && !this.isHost) this.leading = false;
      if (!this.active()) {
        if (this.following) this.leave('The instructor ended this class session. Playback is independent again.');
        if (this.leading) this.leading = false;
        this.message = 'Class listening is independent unless you choose to follow an instructor.';
      } else if (this.leading) this.message = 'You are leading class playback, focus and selected sections.';
      else if (this.following && !this.audioBlocked) this.message = 'Following instructor playback. Your mute switches stay on this device; course notes remain shared.';
      else if (!this.following) this.message = this.isHost ? 'Your class session is available. Resume to lead from this device.' : 'An instructor is leading this split. Choose Follow instructor to join.';
      this.render();
    }

    schedulePoll() {
      clearTimeout(this.pollTimer);
      if (!this.disposed && !this.accessLost && !document.hidden) this.pollTimer = setTimeout(() => void this.read(), this.retryDelay || POLL_MS);
    }

    async read() {
      clearTimeout(this.pollTimer);
      if (!this.usable()) { if (!this.disposed && !document.hidden) this.schedulePoll(); return; }
      if (this.reading || this.writing) { this.schedulePoll(); return; }
      this.reading = true;
      const generation = this.generation;
      try {
        const value = await this.request();
        if (generation !== this.generation || !this.usable()) return;
        this.accept(value);
        if (this.following) await this.apply();
        if (this.leading && Date.now() - (this.lastWrite || 0) >= HEARTBEAT_MS) this.queueUpdate();
      } catch (error) {
        if (generation === this.generation && this.usable()) this.fail(error);
      } finally { this.reading = false; this.schedulePoll(); }
    }

    fail(error) {
      this.generation++;
      this.pauseLocally(); this.leading = false; this.following = false; this.pending = false;
      clearTimeout(this.writeTimer);
      this.failed = true; this.ready = false; this.session = null;
      this.retryDelay = error?.status === 429 ? 60000 : 10000;
      if (!this.concealed) {
        this.concealed = [...this.mixer.el.children].filter(node => node !== this.bar).map(node => [node, node.hidden]);
        for (const [node] of this.concealed) node.hidden = true;
      }
      this.message = [401, 403, 404].includes(error?.status)
        ? 'This class session is no longer available to your account. Reload to check course access.'
        : error?.status === 429 ? 'Class connection is busy. Playback paused; retry in a minute.'
        : 'Class connection was lost. Playback paused. Retry before joining again.';
      if ([401, 403, 404].includes(error?.status)) {
        // A failed authority check conceals this recording immediately; the
        // ordinary account guard cannot substitute for a course recheck.
        this.accessLost = true;
        this.mixer.annotations = []; this.mixer.job.annotations = [];
      }
      this.render();
    }

    queueUpdate() {
      if (!this.leading || this.internal || !this.usable()) return;
      this.pending = true;
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => void this.update(), 150);
    }

    publishFinalPause() {
      if (!this.isHost || !this.active()) return;
      // One best-effort, conditional pause on page exit; never a background
      // heartbeat or a retry of an uncertain write. If another write won the
      // revision race, the server's short lease remains the final boundary.
      const body = { action: 'update', expectedRevision: this.revision, ...this.snapshot(), playing: false };
      void fetch(this.url, { method: 'PUT', credentials: 'same-origin', cache: 'no-store', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Stem-Course': this.mixer.job.courseId }, body: JSON.stringify(body),
      }).catch(() => {});
    }

    async update() {
      if (!this.pending || !this.leading || !this.usable()) return;
      if (this.writing || this.reading) { this.writeTimer = setTimeout(() => void this.update(), 150); return; }
      this.pending = false;
      await this.write('update');
      if (this.pending) this.queueUpdate();
    }

    async write(action) {
      if (this.writing || !this.usable()) return false;
      this.writing = true;
      const generation = this.generation;
      try {
        const state = this.snapshot();
        const value = await this.request('PUT', { action, expectedRevision: this.revision, ...(action === 'end' ? {} : state) });
        if (generation !== this.generation || !this.usable()) return false;
        this.lastWrite = Date.now(); this.accept(value); return true;
      } catch (error) {
        if (generation === this.generation && this.usable()) {
          if (error?.status === 409) {
            this.pauseLocally(); this.leading = false; this.pending = false;
            this.message = 'The class session changed. Refreshing its current state.';
          } else this.fail(error);
        }
        return false;
      } finally { this.writing = false; this.render(); this.schedulePoll(); }
    }

    async start() {
      if (!this.ready || !this.canControl || this.busy) return;
      this.busy = true; this.render();
      const action = this.active() && this.isHost ? 'update' : 'start';
      this.leading = true;
      if (!await this.write(action)) this.leading = false;
      this.busy = false; this.render();
    }

    async end() {
      if (!this.isHost || this.busy) return;
      this.busy = true; this.leading = false; this.pending = false;
      clearTimeout(this.writeTimer); this.pauseLocally(); this.render();
      await this.write('end');
      this.busy = false; this.render();
    }

    async follow() {
      if (!this.active() || this.isHost || this.following) return;
      this.following = true; this.audioBlocked = false;
      this.priorFocus = this.mixer.soloState ? { ...this.mixer.soloState } : null;
      this.priorLoop = this.mixer.loop ? { ...this.mixer.loop } : null;
      this.priorRate = this.mixer.rate;
      this.message = 'Following instructor playback. Your mute switches stay on this device; course notes remain shared.';
      this.render(); await this.apply(true);
    }

    leave(message = 'You left the class session. Playback is independent again.') {
      const wasFollowing = this.following;
      this.following = false; this.audioBlocked = false;
      this.pauseLocally();
      if (wasFollowing) this.inside(() => {
        this.original.setRate(this.priorRate || 1);
        this.mixer.soloState = this.priorFocus || null;
        this.original.setLoop(this.priorLoop || null);
        this.original.applyMix();
      });
      this.message = message; this.render();
      this.original.paintSeekControl(this.mixer.audios[0]?.currentTime || 0);
    }

    projectedPosition() {
      const session = this.session;
      let time = session.position + (session.playing ? Math.max(0, Date.now() + this.offset - session.updatedAt) / 1000 * session.playbackRate : 0);
      const selection = session.selection;
      if (selection && time >= selection.end) time = selection.start + (time - selection.start) % (selection.end - selection.start);
      return Math.max(0, Math.min(time, this.mixer.seekDuration() || time));
    }

    async apply(userGesture = false) {
      if (!this.following || !this.active() || !this.usable() || this.applying) return;
      if (!this.mixer.seekDuration()) return;
      this.applying = true; this.internal++;
      try {
        const mixer = this.mixer;
        this.original.setRate(this.session.playbackRate);
        this.original.setLoop(this.session.selection ? { ...this.session.selection } : null);
        mixer.soloState = this.focus(); mixer.applyMix();
        const desired = this.projectedPosition();
        if (Math.abs((mixer.audios[0]?.currentTime || 0) - desired) > DRIFT_SECONDS) this.original.seekTo(desired);
        if (!this.session.playing) { this.original.pause(); this.audioBlocked = false; }
        else if ((!this.audioBlocked || userGesture) && !mixer.playing && !mixer.starting) {
          // This is reached synchronously from Follow/Join clicks so browsers
          // may use the gesture; later polls never repeatedly retry rejection.
          const disabled = mixer.playBtn.disabled;
          mixer.playBtn.disabled = false;
          const started = this.original.play();
          mixer.playBtn.disabled = disabled;
          await started;
          if (!mixer.playing) {
            this.audioBlocked = true;
            this.message = 'Your browser paused class audio. Join class audio to continue.';
          } else this.audioBlocked = false;
        }
      } finally { this.internal--; this.applying = false; this.render(); }
    }

    async joinAudio() {
      if (!this.following || !this.active()) return;
      this.audioBlocked = false; await this.apply(true);
    }

    dispose() {
      if (this.disposed) return;
      if (this.leading) this.publishFinalPause();
      this.disposed = true; this.generation++;
      clearTimeout(this.pollTimer); clearTimeout(this.writeTimer); this.abort?.abort();
      this.pauseLocally(); controllers.delete(this);
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.mixer.el.removeEventListener('keydown', this.keyHandler, true);
      this.mixer.audios.forEach(audio => audio.removeEventListener('loadedmetadata', this.metadataHandler));
    }
  }

  window.StemClassLive = {
    attach(mixer) {
      if (!mixer?.job?.courseId || mixer.job.readOnlyShared || mixer.classSession) return;
      mixer.classSession = new ClassSession(mixer);
    },
  };
  window.addEventListener('pagehide', () => { for (const controller of controllers) controller.dispose(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();

// Runs in the page's MAIN world on YouTube, at document_start.
// YouTube's web player streams over SABR, so there are no direct media URLs to fetch.
// Instead we record the fMP4 bytes the player appends to its MediaSource buffers,
// make the player fetch the whole video by seeking ahead, then mux and save in-page.
(() => {
  if (window.__fdlInjected) return;
  window.__fdlInjected = true;

  const { readBoxes } = globalThis.FDLMux;
  const { sanitize } = globalThis.FDLOptions;

  // ===================== Keep the player on MP4 =====================
  // mux.js only handles fMP4. Hiding WebM makes the player pick H.264/AV1 + AAC instead
  // of VP9/Opus. AV1 is hidden too by default: many players (e.g. the Windows one) show
  // only a black picture for it. The user can allow it from the menu to get 1440p/4K.
  const AV1_KEY = 'fdl-yt-av1';
  let allowAv1 = false;
  try {
    allowAv1 = localStorage.getItem(AV1_KEY) === '1';
  } catch {}
  const BLOCKED = allowAv1 ? /webm|vp0?9|opus/i : /webm|vp0?9|opus|av01/i;
  for (const MS of [window.MediaSource, window.ManagedMediaSource]) {
    if (!MS?.isTypeSupported) continue;
    const orig = MS.isTypeSupported.bind(MS);
    MS.isTypeSupported = (type) => !BLOCKED.test(type) && orig(type);
  }
  const origCanPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return BLOCKED.test(type) ? '' : origCanPlay.call(this, type);
  };
  const origDecodingInfo = window.MediaCapabilities?.prototype.decodingInfo;
  if (origDecodingInfo) {
    MediaCapabilities.prototype.decodingInfo = function (cfg) {
      const types = `${cfg?.video?.contentType || ''} ${cfg?.audio?.contentType || ''}`;
      if (BLOCKED.test(types)) return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      return origDecodingInfo.call(this, cfg);
    };
  }

  function setAllowAv1(on) {
    try {
      if (on) localStorage.setItem(AV1_KEY, '1');
      else localStorage.removeItem(AV1_KEY);
    } catch {}
    location.reload(); // the player picks its codecs once, at load
  }

  // ===================== Recording MediaSource appends =====================

  const msByUrl = new Map(); // blob: URL -> MediaSource
  const sbState = new WeakMap(); // SourceBuffer -> parser state
  const store = new Map(); // YouTube video id -> { id, tracks: Map(key -> track), drm, touched }
  let job = null;

  const origCreateUrl = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateUrl.call(this, obj);
    if (obj instanceof MediaSource) msByUrl.set(url, obj);
    return url;
  };

  const origAddSb = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAddSb.call(this, mime);
    if (/mp4/i.test(mime)) sbState.set(sb, { ms: this, kind: /^audio/i.test(mime) ? 'audio' : 'video', pending: null, fmt: null, moof: null });
    return sb;
  };

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const s = sbState.get(this);
    if (s) {
      try {
        feed(s, data);
      } catch (e) {
        console.warn('[FDownloader]', e);
        s.pending = s.moof = null;
      }
    }
    return origAppend.call(this, data);
  };

  // abort() drops a half-appended segment; so do we.
  const origAbort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    const s = sbState.get(this);
    if (s) s.pending = s.moof = null;
    return origAbort.call(this);
  };

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function child(u8, box, path) {
    for (const t of path) {
      if (!box) return null;
      box = readBoxes(u8, box.start + box.header, box.end).find((b) => b.type === t);
    }
    return box || null;
  }

  // Appends can split boxes anywhere, so keep the unfinished tail for the next append.
  function feed(s, data) {
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const u8 = s.pending ? concat([s.pending, view]) : view.slice(); // copy: the player may reuse its buffer
    let used = 0;
    for (const b of readBoxes(u8, 0, u8.length)) {
      used = b.end;
      if (b.type === 'ftyp') s.ftyp = u8.slice(b.start, b.end);
      else if (b.type === 'moov') s.fmt = describe(s, u8, b);
      else if (b.type === 'moof') s.moof = u8.slice(b.start, b.end);
      else if (b.type === 'mdat' && s.moof) {
        if (s.fmt) addFrag(s, s.moof, u8.subarray(b.start, b.end));
        s.moof = null;
      }
    }
    s.pending = used < u8.length ? u8.slice(used) : null;
    // Not box-structured after all: stop buffering instead of growing forever.
    if (s.pending && s.pending.length > 64e6) s.pending = null;
  }

  // Format of an init segment: codec, size/channels, timescale and default duration.
  function describe(s, u8, moov) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const trak = child(u8, moov, ['trak']);
    const mdhd = child(u8, trak, ['mdia', 'mdhd']);
    const stsd = child(u8, trak, ['mdia', 'minf', 'stbl', 'stsd']);
    const trex = child(u8, moov, ['mvex', 'trex']);
    if (!mdhd || !stsd || !trex) return null;
    const v1 = u8[mdhd.start + mdhd.header] === 1;
    const entry = stsd.start + stsd.header + 8; // first sample entry, after version/flags + count
    const codec = String.fromCharCode(...u8.subarray(entry + 4, entry + 8));
    if (codec === 'encv' || codec === 'enca') {
      const rec = record(currentId(s.ms));
      if (rec) rec.drm = true;
      return null;
    }
    const fmt = {
      kind: s.kind,
      codec,
      timescale: dv.getUint32(mdhd.start + mdhd.header + 4 + (v1 ? 16 : 8)),
      defDur: dv.getUint32(trex.start + trex.header + 12),
      init: concat([s.ftyp || new Uint8Array(0), u8.subarray(moov.start, moov.end)]),
      width: 0,
      height: 0,
      channels: 0,
    };
    if (s.kind === 'video') {
      fmt.width = dv.getUint16(entry + 32);
      fmt.height = dv.getUint16(entry + 34);
    } else {
      fmt.channels = dv.getUint16(entry + 24);
    }
    fmt.key = [fmt.kind, fmt.codec, fmt.width, fmt.height, fmt.channels, fmt.timescale].join('|');
    return fmt;
  }

  // Start time and duration (seconds) of a moof, from tfdt + trun.
  function fragTiming(m, fmt) {
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    const traf = child(m, readBoxes(m, 0, m.length)[0], ['traf']);
    let start = 0;
    let dur = 0;
    let def = fmt.defDur;
    for (const b of readBoxes(m, traf.start + traf.header, traf.end)) {
      const o = b.start + b.header;
      const flags = dv.getUint32(o) & 0xffffff;
      if (b.type === 'tfdt') start = m[o] === 1 ? Number(dv.getBigUint64(o + 4)) : dv.getUint32(o + 4);
      else if (b.type === 'tfhd' && flags & 0x8) def = dv.getUint32(o + 8 + (flags & 0x1 ? 8 : 0) + (flags & 0x2 ? 4 : 0));
      else if (b.type === 'trun') {
        const n = dv.getUint32(o + 4);
        if (!(flags & 0x100)) {
          dur += n * def;
          continue;
        }
        let p = o + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
        const step = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
        for (let i = 0; i < n; i++, p += step) dur += dv.getUint32(p);
      }
    }
    return { time: start, t: start / fmt.timescale, d: dur / fmt.timescale };
  }

  function playerOf(ms) {
    for (const v of document.querySelectorAll('video')) if (msByUrl.get(v.src) === ms) return v.closest('.html5-video-player');
    return null;
  }

  // The video the player is showing right now; null during ads.
  function currentId(ms) {
    const p = playerOf(ms);
    if (!p || p.classList.contains('ad-showing')) return null;
    return p.getVideoData?.()?.video_id || null;
  }

  function record(id) {
    if (!id) return null;
    let rec = store.get(id);
    if (!rec) {
      rec = { id, tracks: new Map(), drm: false, touched: 0 };
      store.set(id, rec);
      // Captured media is large: keep only the most recent videos.
      const old = [...store.values()].filter((r) => r.id !== job?.id && r !== rec).sort((a, b) => b.touched - a.touched);
      for (const r of old.slice(2)) store.delete(r.id);
    }
    rec.touched = Date.now();
    return rec;
  }

  function addFrag(s, moof, mdat) {
    const rec = record(currentId(s.ms));
    if (!rec) return;
    let track = rec.tracks.get(s.fmt.key);
    if (!track) {
      track = { ...s.fmt, frags: new Map(), last: 0 };
      rec.tracks.set(s.fmt.key, track);
    }
    const f = fragTiming(moof, s.fmt);
    if (!track.frags.has(f.time)) track.frags.set(f.time, { t: f.t, d: f.d, bytes: concat([moof, mdat]) });
    track.last = Date.now();
    if (job) job.step();
  }

  // ===================== Coverage and file assembly =====================

  const sortedFrags = (track) => [...track.frags.values()].sort((a, b) => a.t - b.t);
  const minDim = (t) => Math.min(t.width, t.height) || t.height;

  // End of the continuous run that starts at 0.
  function coveredUntil(track) {
    if (!track) return 0;
    let end = 0;
    for (const f of sortedFrags(track)) {
      if (f.t > end + 0.25) break;
      end = Math.max(end, f.t + f.d);
    }
    return end;
  }

  function coveredTotal(track) {
    let sum = 0;
    let end = 0;
    for (const f of sortedFrags(track)) {
      const from = Math.max(f.t, end);
      if (f.t + f.d > from) sum += f.t + f.d - from;
      end = Math.max(end, f.t + f.d);
    }
    return sum;
  }

  // wantH: lock to that height (null if not captured yet); 0: the best-covered tracks.
  function pickTracks(rec, wantH) {
    const all = rec ? [...rec.tracks.values()] : [];
    const best = (list) => list.sort((a, b) => coveredTotal(b) - coveredTotal(a) || minDim(b) - minDim(a))[0] || null;
    const videos = all.filter((t) => t.kind === 'video');
    return {
      video: best(wantH ? videos.filter((t) => minDim(t) === wantH) : videos),
      audio: best(all.filter((t) => t.kind === 'audio')),
    };
  }

  // Init segment + fragments in time order, skipping ones that overlap what is already in.
  function trackBytes(track) {
    const parts = [track.init];
    let end = -1;
    for (const f of sortedFrags(track)) {
      if (f.t < end - 0.05) continue;
      parts.push(f.bytes);
      end = f.t + f.d;
    }
    return concat(parts);
  }

  function saveFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    a.addEventListener('click', (e) => e.stopPropagation());
    (document.body || document.documentElement).append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  function save(id, title, { height = 0, audioOnly = false } = {}) {
    const { video, audio } = pickTracks(store.get(id), height);
    const base = sanitize(title || `youtube_${id}`);
    if (audioOnly || !video) {
      if (!audio) throw new Error('Chưa thu được dữ liệu');
      saveFile(new Blob([trackBytes(audio)], { type: 'audio/mp4' }), `${base} [audio].m4a`);
      return;
    }
    const q = `${minDim(video)}p${video.codec === 'av01' ? ' AV1' : ''}`;
    const vBytes = trackBytes(video);
    if (!audio) {
      saveFile(new Blob([vBytes], { type: 'video/mp4' }), `${base} [${q}] (không tiếng).mp4`);
      return;
    }
    const aBytes = trackBytes(audio);
    try {
      saveFile(FDLMux.mux(vBytes, aBytes), `${base} [${q}].mp4`);
    } catch (e) {
      // Fall back to two separate files so the user still gets the content.
      console.error('[FDownloader]', e);
      saveFile(new Blob([vBytes], { type: 'video/mp4' }), `${base} [${q}] (video).mp4`);
      saveFile(new Blob([aBytes], { type: 'audio/mp4' }), `${base} [${q}] (audio).m4a`);
      throw new Error('Không ghép được, đã lưu hình và tiếng thành 2 file riêng');
    }
  }

  // ===================== Driving the player through the whole video =====================

  const QUALITY_H = { highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };

  // Seeks to the first missing second each time new data arrives, so the player keeps
  // fetching as fast as the network allows. Resolves once audio + video reach the end.
  function runCapture(j) {
    const { el, player } = j;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let lastGain = Date.now();
      let lastEnd = -1;
      let seekedTo = -1;
      let seekedAt = 0;
      let otherSince = 0;
      // While the player swaps sources after a seek, el.duration is NaN and getDuration()
      // returns 0; keep the last real value or the capture would "finish" right there.
      let dur = 0;
      const finish = (err) => {
        clearInterval(timer);
        j.step = () => {};
        err ? reject(err) : resolve();
      };
      j.step = () => {
        const now = Date.now();
        if (j.cancelled) return finish(new Error('Đã dừng'));
        const playing = player.getVideoData?.()?.video_id;
        if (player.classList.contains('ad-showing') || playing !== j.id) {
          FDLUI.setProgress(j.id, { state: 'waiting', text: 'Đang chờ quảng cáo / video phát lại…' });
          if (!player.classList.contains('ad-showing')) {
            otherSince ||= now;
            if (now - otherSince > 15000) return finish(new Error('Video đã bị chuyển'));
          }
          lastGain = now;
          return;
        }
        otherSince = 0;

        const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : player.getDuration();
        if (d > 0) dur = d;
        // The player may not honour the quality lock; after 15s take whatever it streams.
        if (j.wantH && now - startedAt > 15000 && !pickTracks(store.get(j.id), j.wantH).video) j.wantH = 0;
        const { video, audio } = pickTracks(store.get(j.id), j.wantH);
        const end = Math.min(coveredUntil(audio), j.audioOnly ? Infinity : coveredUntil(video));
        const pct = dur ? Math.min(99, Math.floor((end / dur) * 100)) : 0;
        FDLUI.setProgress(j.id, { state: 'downloading', pct, text: `Đang thu dữ liệu ${pct}% (giữ tab này mở)` });

        if (dur && end >= dur - 0.5) return finish();
        if (end > lastEnd + 0.01) {
          lastEnd = end;
          lastGain = now;
        } else if (dur && now - lastGain > 8000 && end >= dur - 2) {
          return finish(); // tracks end a bit before the reported duration
        } else if (now - lastGain > 45000) {
          return finish(new Error('Không tải thêm được dữ liệu'));
        }
        if (end > seekedTo + 0.5 || now - seekedAt > 20000) {
          seekedTo = end;
          seekedAt = now;
          player.seekTo(end, true);
          player.playVideo();
        }
      };
      const timer = setInterval(() => j.step(), 300);
      j.step();
    });
  }

  async function start(el, id, opt) {
    const player = el.closest('.html5-video-player');
    const title = player.getVideoData().title;
    const restore = { muted: player.isMuted(), paused: el.paused, time: el.currentTime };
    job = { id, el, player, wantH: opt.height || 0, audioOnly: !!opt.audioOnly, cancelled: false, step: () => {} };
    FDLUI.setProgress(id, { state: 'downloading', pct: 0, text: 'Đang thu dữ liệu…' });
    try {
      if (opt.quality) {
        player.setPlaybackQualityRange?.(opt.quality, opt.quality);
        player.setPlaybackQuality?.(opt.quality);
      }
      player.mute();
      await runCapture(job);
      FDLUI.setProgress(id, { state: 'muxing', pct: 100, text: 'Đang ghép hình và tiếng…' });
      await new Promise((r) => setTimeout(r, 50)); // let the label repaint
      save(id, title, { height: job.wantH, audioOnly: job.audioOnly });
      FDLUI.setProgress(id, { state: 'done', pct: 100, text: 'Đã tải xong' });
    } catch (e) {
      if (job.cancelled) FDLUI.setProgress(id, null);
      else {
        console.error('[FDownloader]', e);
        FDLUI.setProgress(id, { state: 'error', pct: 0, text: 'Lỗi: ' + e.message });
      }
    } finally {
      job = null;
      player.seekTo(restore.time, true);
      if (restore.paused) player.pauseVideo();
      if (!restore.muted) player.unMute();
    }
  }

  // ===================== On-page download button =====================

  const playerData = (el) => el.closest('.html5-video-player')?.getVideoData?.() || null;

  function qualityChoices(player) {
    const data = player.getAvailableQualityData?.();
    if (Array.isArray(data) && data.length)
      return data.filter((d) => QUALITY_H[d.quality] && d.isPlayable !== false).map((d) => ({ quality: d.quality, label: d.qualityLabel || `${QUALITY_H[d.quality]}p` }));
    return (player.getAvailableQualityLevels?.() || []).filter((q) => QUALITY_H[q]).map((q) => ({ quality: q, label: `${QUALITY_H[q]}p` }));
  }

  function buildMenu(el, id) {
    const player = el.closest('.html5-video-player');
    const data = playerData(el);
    if (!id || !data) return [{ text: 'Chưa đọc được video này. Hãy phát video, hoặc tải lại trang (F5) rồi thử lại.', muted: true }];
    const title = data.title || `Video ${id}`;
    const items = [{ text: title.length > 70 ? title.slice(0, 70) + '…' : title, muted: true }];
    if (data.isLive) return [...items, { text: 'Chưa hỗ trợ tải video đang phát trực tiếp.', muted: true }];
    const rec = store.get(id);
    if (rec?.drm) return [...items, { text: 'Video này có DRM, không tải được.', muted: true }];
    if (job) {
      if (job.id === id) items.push({ text: '■ Dừng thu dữ liệu', bold: true, onClick: () => (job.cancelled = true) });
      else items.push({ text: 'Đang tải một video khác, hãy đợi xong.', muted: true });
      return items;
    }

    qualityChoices(player).forEach((q, i) =>
      items.push({
        text: (i === 0 ? '★ ' : '') + q.label,
        bold: i === 0,
        onClick: () => start(el, id, { quality: q.quality, height: QUALITY_H[q.quality] }),
      })
    );
    items.push({ text: 'Chỉ âm thanh (m4a)', onClick: () => start(el, id, { audioOnly: true }) });
    items.push(
      allowAv1
        ? { text: 'Tắt AV1: dùng H.264, mở được ở mọi trình phát (tải lại trang)', onClick: () => setAllowAv1(false) }
        : { text: 'Bật AV1 để có 1440p/4K, Windows Media Player sẽ không hiện hình (tải lại trang)', onClick: () => setAllowAv1(true) }
    );

    const { video, audio } = pickTracks(rec, 0);
    const dur = player.getDuration();
    if (video && audio && dur) {
      const pct = Math.min(100, Math.floor((Math.min(coveredTotal(video), coveredTotal(audio)) / dur) * 100));
      items.push({
        text: `Lưu phần đã xem (${minDim(video)}p · ${pct}%)`,
        onClick: () => {
          try {
            save(id, title);
          } catch (e) {
            FDLUI.setProgress(id, { state: 'error', pct: 0, text: 'Lỗi: ' + e.message });
          }
        },
      });
    }
    items.push({ text: 'Extension sẽ tua video để thu dữ liệu từ trình phát. Giữ tab này mở cho tới khi xong.', muted: true });
    return items;
  }

  FDLUI.init({
    videoSelector: '#movie_player video, #shorts-player video',
    // Shorts have a Like/Comment/Share column next to the video; the watch page has the
    // recommendations there instead, so only look for the column on /shorts/.
    actionSelector: () => (location.pathname.startsWith('/shorts/') ? 'button' : ''),
    buttonBg: 'rgba(0,0,0,.45)',
    accent: '#ff0033',
    // Watch page: first item of the Like/Share row under the video, styled like its pills.
    mount(el, btn) {
      if (!el.closest('#movie_player') || !location.pathname.startsWith('/watch')) return false;
      const row = document.querySelector('ytd-watch-metadata #actions ytd-menu-renderer') || document.querySelector('ytd-watch-metadata #actions');
      if (!row?.getClientRects().length) return false;
      if (btn.parentNode !== row) row.prepend(btn);
      return true;
    },
    inlineBg: 'var(--yt-spec-badge-chip-background, rgba(0,0,0,.05))',
    inlineHover: 'var(--yt-spec-button-chip-background-hover, rgba(0,0,0,.1))',
    getId: (el) => playerData(el)?.video_id || null,
    buildMenu,
  });
})();

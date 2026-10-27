// Minimal fragmented-MP4 muxer: merges a video-only and an audio-only DASH file
// (from Facebook, or captured from YouTube's player) into a single MP4 with two tracks. No re-encoding.
(function (global) {
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts']);

  function readBoxes(u8, start, end) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const boxes = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      let header = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) break;
      boxes.push({ type, start: p, end: p + size, header });
      p += size;
    }
    return boxes;
  }

  const children = (u8, box) => readBoxes(u8, box.start + box.header, box.end);

  function find(u8, box, path) {
    let cur = box;
    for (const t of path) {
      if (!cur || !CONTAINERS.has(cur.type)) return null;
      cur = children(u8, cur).find((b) => b.type === t);
    }
    return cur || null;
  }

  function makeBox(type, payloads) {
    const size = 8 + payloads.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of payloads) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // Copy of a box's bytes plus a setter that takes absolute file offsets.
  function editable(u8, box) {
    const copy = u8.slice(box.start, box.end);
    const dv = new DataView(copy.buffer);
    return {
      bytes: copy,
      u32: (abs, v) => dv.setUint32(abs - box.start, v),
      getU32: (abs) => dv.getUint32(abs - box.start),
      u64: (abs, v) => dv.setBigUint64(abs - box.start, BigInt(v)),
      getU64: (abs) => Number(dv.getBigUint64(abs - box.start)),
    };
  }

  function parse(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const top = readBoxes(u8, 0, u8.length);
    const ftyp = top.find((b) => b.type === 'ftyp');
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error('Không tìm thấy moov');
    const moovKids = children(u8, moov);
    const mvhd = moovKids.find((b) => b.type === 'mvhd');
    const trak = moovKids.find((b) => b.type === 'trak');
    const mvex = moovKids.find((b) => b.type === 'mvex');
    if (!mvhd || !trak) throw new Error('File MP4 thiếu mvhd/trak');
    const trex = mvex && children(u8, mvex).find((b) => b.type === 'trex');
    const mehd = mvex && children(u8, mvex).find((b) => b.type === 'mehd');
    const mdhd = find(u8, trak, ['mdia', 'mdhd']);
    const tkhd = find(u8, trak, ['tkhd']);
    if (!mdhd || !tkhd || !trex) throw new Error('File không phải MP4 phân mảnh (fMP4)');

    const ver = (b) => u8[b.start + b.header];
    const trackTimescale = dv.getUint32(mdhd.start + mdhd.header + 4 + (ver(mdhd) === 1 ? 16 : 8));

    const mvhdTsOff = mvhd.start + mvhd.header + 4 + (ver(mvhd) === 1 ? 16 : 8);
    const movieTimescale = dv.getUint32(mvhdTsOff);
    let movieDuration = ver(mvhd) === 1 ? Number(dv.getBigUint64(mvhdTsOff + 4)) : dv.getUint32(mvhdTsOff + 4);
    if (mehd) {
      const md = ver(mehd) === 1 ? Number(dv.getBigUint64(mehd.start + mehd.header + 4)) : dv.getUint32(mehd.start + mehd.header + 4);
      movieDuration = Math.max(movieDuration, md);
    }

    const frags = [];
    let cur = null;
    for (const b of top) {
      if (b.type === 'moof') {
        cur = { moof: b, mdats: [], time: 0 };
        frags.push(cur);
      } else if (b.type === 'mdat' && cur) {
        cur.mdats.push(b);
      }
    }
    if (!frags.length) throw new Error('File không có fragment (moof)');

    for (const f of frags) {
      const tfdt = find(u8, f.moof, ['traf', 'tfdt']);
      if (tfdt) {
        const t = ver(tfdt) === 1 ? Number(dv.getBigUint64(tfdt.start + tfdt.header + 4)) : dv.getUint32(tfdt.start + tfdt.header + 4);
        f.time = t / trackTimescale;
      }
    }

    return { u8, ftyp, mvhd, trak, tkhd, trex, frags, movieTimescale, durationSec: movieTimescale ? movieDuration / movieTimescale : 0 };
  }

  // Sets the track ID and moves durations given in the source's movie timescale (tkhd,
  // elst) onto the output's, which is the video file's.
  function retrackTrak(src, trackId, outTimescale) {
    const { u8, trak, tkhd } = src;
    const e = editable(u8, trak);
    const scale = (v) => (src.movieTimescale ? Math.round((v * outTimescale) / src.movieTimescale) : 0);
    const v1 = u8[tkhd.start + tkhd.header] === 1;
    const idOff = tkhd.start + tkhd.header + 4 + (v1 ? 16 : 8);
    e.u32(idOff, trackId);
    if (v1) e.u64(idOff + 8, scale(e.getU64(idOff + 8)));
    else e.u32(idOff + 8, Math.min(scale(e.getU32(idOff + 8)), 0xffffffff));

    // The last edit gets duration 0 ("to the end of the track", as fMP4 allows). With its
    // real duration Windows (Media Foundation) refuses to decode the H.264 track.
    const elst = find(u8, trak, ['edts', 'elst']);
    if (elst) {
      const ev1 = u8[elst.start + elst.header] === 1;
      const count = e.getU32(elst.start + elst.header + 4);
      const size = ev1 ? 20 : 12;
      for (let i = 0; i < count; i++) {
        const off = elst.start + elst.header + 8 + i * size;
        const dur = i === count - 1 ? 0 : scale(ev1 ? e.getU64(off) : e.getU32(off));
        if (ev1) e.u64(off, dur);
        else e.u32(off, Math.min(dur, 0xffffffff));
      }
    }
    return e.bytes;
  }

  function retrackTrex(src, trackId) {
    const e = editable(src.u8, src.trex);
    e.u32(src.trex.start + src.trex.header + 4, trackId);
    return e.bytes;
  }

  function buildMvhd(video, durationSec) {
    const { u8, mvhd } = video;
    const e = editable(u8, mvhd);
    const v1 = u8[mvhd.start + mvhd.header] === 1;
    const tsOff = mvhd.start + mvhd.header + 4 + (v1 ? 16 : 8);
    const dur = Math.round(durationSec * e.getU32(tsOff));
    if (dur > 0) {
      if (v1) e.u64(tsOff + 4, dur);
      else e.u32(tsOff + 4, Math.min(dur, 0xffffffff));
    }
    e.u32(mvhd.end - 4, 3); // next_track_ID
    return e.bytes;
  }

  function patchMoof(src, frag, trackId, seq, newStart) {
    const { u8 } = src;
    const { moof } = frag;
    const e = editable(u8, moof);
    for (const b of children(u8, moof)) {
      if (b.type === 'mfhd') e.u32(b.start + b.header + 4, seq);
      if (b.type !== 'traf') continue;
      const tfhd = children(u8, b).find((x) => x.type === 'tfhd');
      if (!tfhd) continue;
      const flags = (u8[tfhd.start + tfhd.header + 1] << 16) | (u8[tfhd.start + tfhd.header + 2] << 8) | u8[tfhd.start + tfhd.header + 3];
      e.u32(tfhd.start + tfhd.header + 4, trackId);
      if (flags & 0x1) {
        // Explicit base_data_offset is absolute in the source file; rebase it.
        const off = tfhd.start + tfhd.header + 8;
        e.u64(off, e.getU64(off) - moof.start + newStart);
      }
    }
    return e.bytes;
  }

  /**
   * @param {Uint8Array} videoBytes
   * @param {Uint8Array} audioBytes
   * @returns {Blob}
   */
  function mux(videoBytes, audioBytes) {
    const video = parse(videoBytes);
    const audio = parse(audioBytes);

    const ftyp = video.ftyp
      ? videoBytes.slice(video.ftyp.start, video.ftyp.end)
      : makeBox('ftyp', [new TextEncoder().encode('isom'), new Uint8Array(4), new TextEncoder().encode('isomiso6mp41')]);

    const moov = makeBox('moov', [
      buildMvhd(video, Math.max(video.durationSec, audio.durationSec)),
      retrackTrak(video, 1, video.movieTimescale),
      retrackTrak(audio, 2, video.movieTimescale),
      makeBox('mvex', [retrackTrex(video, 1), retrackTrex(audio, 2)]),
    ]);

    const all = [
      ...video.frags.map((f, i) => ({ src: video, f, trackId: 1, order: i })),
      ...audio.frags.map((f, i) => ({ src: audio, f, trackId: 2, order: i })),
    ].sort((a, b) => a.f.time - b.f.time || a.trackId - b.trackId || a.order - b.order);

    const parts = [ftyp, moov];
    let pos = ftyp.length + moov.length;
    let seq = 1;
    for (const { src, f, trackId } of all) {
      const moofBytes = patchMoof(src, f, trackId, seq++, pos);
      parts.push(moofBytes);
      pos += moofBytes.length;
      for (const m of f.mdats) {
        const chunk = src.u8.subarray(m.start, m.end);
        parts.push(chunk);
        pos += chunk.length;
      }
    }
    return new Blob(parts, { type: 'video/mp4' });
  }

  global.FDLMux = { mux, parse, readBoxes };
})(typeof self !== 'undefined' ? self : globalThis);

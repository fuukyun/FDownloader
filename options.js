// Shared by the page script (inject.js) and the popup: turns a captured video
// record into a list of download choices, best first.
(function (g) {
  const CODECS = { av01: 'AV1', vp09: 'VP9', avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265', hev1: 'H.265' };
  const fmtCodec = (c) => CODECS[(c || '').slice(0, 4)] || '';
  const fmtRate = (bps) =>
    !bps ? '' : bps < 3e5 ?Math.round(bps / 1000) + ' kbps' : (bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1) + ' Mbps';

  function sanitize(name) {
    return (
      name
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/[#@]\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim() || 'facebook_video'
    );
  }

  function bestAudio(v) {
    return v.reps.filter((r) => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
  }

  function videoReps(v) {
    return v.reps
      .filter((r) => r.kind === 'video')
      .sort((a, b) => b.height * b.width - a.height * a.width || b.bandwidth - a.bandwidth);
  }

  function buildOptions(v) {
    const opts = [];
    const audio = bestAudio(v);
    for (const r of videoReps(v)) {
      const q = r.label || (r.height ? `${Math.min(r.height, r.width || r.height)}p` : 'Video');
      opts.push({
        label: [q, fmtCodec(r.codecs), fmtRate(r.bandwidth)].filter(Boolean).join(' · ') + (audio ? '' : ' (không tiếng)'),
        job: { videoUrl: r.url, audioUrl: audio?.url || null, quality: q },
      });
    }
    if (v.progressive.HD) opts.push({ label: 'HD · file gốc có tiếng', job: { videoUrl: v.progressive.HD, quality: 'HD' } });
    if (v.progressive.SD) opts.push({ label: 'SD · file gốc có tiếng', job: { videoUrl: v.progressive.SD, quality: 'SD' } });
    if (audio) opts.push({ label: `Chỉ âm thanh · ${fmtRate(audio.bandwidth)}`, job: { videoUrl: audio.url, quality: 'audio', audioOnly: true } });
    return opts;
  }

  function makeJob(v, opt) {
    const ext = opt.job.audioOnly ? 'm4a' : 'mp4';
    const base = sanitize(v.title.split('\n')[0] || `facebook_${v.id}`);
    return { ...opt.job, videoId: v.id, filename: `${base} [${opt.job.quality}].${ext}` };
  }

  g.FDLOptions = { buildOptions, makeJob, fmtCodec };
})(globalThis);

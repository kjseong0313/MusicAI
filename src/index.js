// Apple은 UA 없는/봇성 요청과 공유 IP를 강하게 레이트리밋한다.
// 브라우저 UA를 붙이고, 실패 시 짧은 간격으로 재시도한다.
const ITUNES_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/javascript,*/*'
};

async function fetchItunesJson(itunesUrl, attempts = 3) {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(itunesUrl, { headers: ITUNES_HEADERS });
      const text = await res.text();
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${text.slice(0, 100)}`; }
      else {
        try { return { data: JSON.parse(text) }; }
        catch { lastErr = `non-JSON: ${text.slice(0, 100)}`; }
      }
    } catch (e) {
      lastErr = e.message;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
  }
  return { error: lastErr };
}

// Apple의 itunes.apple.com이 Cloudflare Workers 공유 IP를 광범위하게 차단해서
// (그리고 일부 클라이언트 네트워크에서도 직접 접속이 막혀서) Deezer를 대체 소스로 사용한다.
// 응답은 iTunes 검색 결과와 동일한 필드 모양으로 변환해 프론트엔드 코드는 그대로 재사용한다.
function mapDeezerTrack(item) {
  return {
    trackId: item.id,
    trackName: item.title,
    artistName: item.artist?.name || '',
    artistId: item.artist?.id,
    collectionName: item.album?.title || '',
    collectionId: item.album?.id,
    artworkUrl60: item.album?.cover_small || '',
    artworkUrl100: item.album?.cover_medium || '',
    trackTimeMillis: (item.duration || 0) * 1000,
    previewUrl: item.preview || '',
    wrapperType: 'track',
    kind: 'song',
  };
}
function mapDeezerAlbum(item) {
  return {
    collectionId: item.id,
    collectionName: item.title,
    artistName: item.artist?.name || '',
    artistId: item.artist?.id,
    artworkUrl60: item.cover_small || '',
    artworkUrl100: item.cover_medium || '',
    trackCount: item.nb_tracks || 0,
    releaseDate: item.release_date || '',
    wrapperType: 'collection',
  };
}
function mapDeezerArtist(item) {
  return {
    artistId: item.id,
    artistName: item.name,
    artworkUrl60: item.picture_small || '',
    artworkUrl100: item.picture_medium || '',
    primaryGenreName: '',
    wrapperType: 'artist',
  };
}

// 커버 아트 아카이브. 없는 음반도 많아서(404) 프론트엔드에서 대체 아이콘으로 넘어간다.
const caaUrl = (kind, id, size) => id ? `https://coverartarchive.org/${kind}/${id}/front-${size}` : '';

function mapMusicBrainzRecording(item) {
  const release = item.releases?.[0];
  // 커버는 개별 발매반보다 release-group에 등록돼 있는 경우가 많아 그쪽을 먼저 쓴다.
  const groupId = release?.['release-group']?.id;
  return {
    trackId: item.id,
    trackName: item.title,
    artistName: item['artist-credit']?.[0]?.artist?.name || item['artist-credit']?.[0]?.name || '',
    artistId: item['artist-credit']?.[0]?.artist?.id || '',
    collectionName: release?.title || '',
    collectionId: groupId || '',
    releaseDate: release?.date || '',
    artworkUrl60: groupId ? caaUrl('release-group', groupId, 250) : caaUrl('release', release?.id, 250),
    artworkUrl100: groupId ? caaUrl('release-group', groupId, 500) : caaUrl('release', release?.id, 500),
    wrapperType: 'track',
    kind: 'song',
  };
}

// Lucene 특수문자를 그대로 넘기면 400이 나거나 질의가 엉뚱하게 해석된다.
function escapeLucene(s) {
  return String(s || '').replace(/(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
}

// 넉넉한 길이의 낱말에는 ~를 붙여 오타를 허용한다(Lucene 퍼지 검색).
// 라틴 문자에만 붙인다 — 한글·한자는 한 글자가 곧 한 음절이라 퍼지를 걸면 "소주한잔"이
// "커피한잔"에 매칭된다. 라틴 문자의 오타("rapsody")와는 성격이 다르다.
function mbQuery(q) {
  const base = String(q || '').split(/\s+/).filter(Boolean)
    // ~1(편집 거리 1)로 조인다. rapsody→rhapsody 같은 한 글자 오타는 그대로 잡으면서
    // 기본값 ~2가 jean에 joan·sean·dean까지 끌어오는 잡음을 줄인다.
    .map(t => /^[A-Za-z0-9]{4,}$/.test(t) ? `${t}~1` : escapeLucene(t))
    .join(' ');

  // 한국어는 같은 말을 붙여 쓰기도 띄어 쓰기도 한다. MusicBrainz에 "벚꽃 엔딩"으로
  // 등록된 곡은 "벚꽃엔딩"으로 검색하면 한 건도 안 잡힌다. 띄어쓰기가 없는 한글
  // 검색어는 띄어쓰기를 넣은 형태를 모두 OR로 함께 던진다(요청은 그대로 한 번이다).
  const bare = String(q || '').trim();
  if (/^[가-힣]{3,8}$/.test(bare)) {
    const spaced = [];
    for (let i = 1; i < bare.length; i++) spaced.push(`"${bare.slice(0, i)} ${bare.slice(i)}"`);
    return `(${base} OR ${spaced.join(' OR ')})`;
  }
  return base;
}

// MusicBrainz의 score(0~100)는 인기도가 아니라 자체 관련도 점수다. 제목이 똑같은 커버가
// 수십 개면 전부 만점이라 순서를 가르지 못한다.
const mbScore = it => (it.score || 0) / 100;

// 그래서 곡은 수록된 음반 수를 유명세의 대용으로 쓴다. 원곡은 정규앨범·컴필레이션·재발매로
// 여러 번 실리지만 무명 커버는 보통 한 장뿐이다.
const mbRecordingPopularity = it => Math.min((it.releases || []).length / 10, 1);

// MusicBrainz는 제목이 같은 후보에 전부 score 100을 주기 때문에 원곡이 상위에 온다는
// 보장이 없다. 흔한 낱말로 된 제목일수록 심하다 — "billie jean"은 15만 건이 매칭되고
// 마이클 잭슨의 원곡은 101번째부터 나온다. 그래서 한 페이지(100건)로는 부족해
// 두 페이지를 받아 200건 중에서 우리 기준으로 다시 줄 세운다.
async function mbSearch(kind, q, limit) {
  const want = Number(limit) || 50;
  const base = `https://musicbrainz.org/ws/2/${kind}/?query=${encodeURIComponent(mbQuery(q))}&limit=100&fmt=json`;
  const json = await mbJson(base);
  const key = kind === 'release-group' ? 'release-groups' : kind === 'artist' ? 'artists' : 'recordings';

  // 두 번째 페이지는 있으면 좋고 없어도 그만이라, 실패해도 첫 페이지로 진행한다.
  if ((json[key] || []).length === 100) {
    try {
      const more = await mbJson(`${base}&offset=100`);
      json[key] = [...json[key], ...(more[key] || [])];
    } catch { /* 첫 페이지만 쓴다 */ }
  }
  return { json, want };
}

const mbArtistOf = it => it['artist-credit']?.[0]?.artist?.name || it['artist-credit']?.[0]?.name || '';

// MusicBrainz에는 인기도 데이터가 아예 없어서 제목이 같은 커버가 원곡을 밀어낸다.
// 가수 이름으로 Deezer에서 팬 수만 빌려와 유명세를 매긴다(Queen 1,279만 vs
// California Guitar Trio 983 — 순서를 가르기에 충분한 차이다).
// Deezer의 가수 검색은 첫 결과가 동명이인일 때가 많아, 이름이 정확히 같은 것 중
// 가장 팬이 많은 쪽을 고른다("Ed Sheeran"의 첫 매치는 팬 2천의 다른 계정이다).
// 가수 조회도 Deezer의 빈 응답 버그를 맞으므로 매번 다른 URL로 두 번까지 시도한다.
// Workers는 요청당 서브요청 50개가 상한이라 10명 × 2회 = 20건으로 묶어 둔다.
async function deezerArtistFame(names) {
  const fame = new Map();
  await Promise.all(names.map(async name => {
    const want = normalize(name);
    for (let i = 0; i < 2; i++) {
      try {
        const nonce = Math.random().toString(36).slice(2, 8);
        const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=40&_n=${nonce}`;
        const res = await fetch(url, DEEZER_FETCH);
        if (res.ok) {
          const json = await res.json();
          const exact = (json.data || []).filter(a => normalize(a.name) === want);
          if (exact.length) {
            const best = exact.sort((x, y) => (y.nb_fan || 0) - (x.nb_fan || 0))[0];
            fame.set(want, { fans: best.nb_fan || 0, id: best.id });
            return;
          }
          // 이름이 정확히 겹치는 가수가 진짜 없으면 다시 걸어도 결과가 같다.
          if ((json.data || []).length) return;
        }
      } catch { /* 아래에서 다시 시도한다 */ }
    }
    /* 끝내 못 구하면 이 가수는 빈도 신호로만 판단한다 */
  }));
  return fame;
}

// 그 가수의 대표곡 목록을 가져온다. MusicBrainz에는 곡별 인기도가 없어서 가수 유명세만
// 보면 "bad guy"가 Billie Eilish(팬 924만)가 아니라 같은 제목의 곡을 가진 Eminem
// (1,909만)에게 간다. 대표곡 50곡 안에는 Billie Eilish 쪽에만 들어 있다.
async function deezerTopTracks(ids) {
  const tops = new Map();
  await Promise.all([...ids].map(async id => {
    // 이 엔드포인트도 빈 응답 버그를 맞는다. 한 번만 걸면 신호가 통째로 날아가서
    // 유명세만으로 순서가 정해지고, 그러면 "bad guy"가 Eminem에게 간다.
    for (let i = 0; i < 3; i++) {
      try {
        const nonce = Math.random().toString(36).slice(2, 8);
        const res = await fetch(`https://api.deezer.com/artist/${id}/top?limit=50&_n=${nonce}`, DEEZER_FETCH);
        if (res.ok) {
          const json = await res.json();
          const titles = json.data || [];
          if (titles.length) { tops.set(String(id), new Set(titles.map(t => normalize(t.title)))); return; }
        }
      } catch { /* 아래에서 다시 시도한다 */ }
      await new Promise(r => setTimeout(r, 200 + i * 200));
    }
  }));
  return tops;
}

async function musicBrainzSearch(q, limit) {
  const { json, want } = await mbSearch('recording', q, limit);
  const recs = json.recordings || [];

  // MusicBrainz는 같은 곡을 발매반·라이브·리마스터마다 별도 recording으로 쪼개 둔다.
  // 그래서 원곡 가수는 같은 제목으로 수십 건이 잡히고 커버 가수는 한두 건뿐이다.
  // 이 "잡힌 건수"가 개별 recording의 음반 수보다 훨씬 안정적인 유명세 지표다 —
  // 검색이 매번 다른 100건을 표본으로 주더라도 가수별 비율은 그대로 유지되기 때문이다.
  const hitsByArtist = new Map();
  for (const r of recs) {
    const k = normalize(mbArtistOf(r));
    hitsByArtist.set(k, (hitsByArtist.get(k) || 0) + 1);
  }

  const byHits = it => Math.min((hitsByArtist.get(normalize(mbArtistOf(it))) || 1) / 8, 1) * 0.8
                     + mbRecordingPopularity(it) * 0.2;

  // 팬 수 조회는 비싸므로(가수당 최대 2회) 먼저 관련도와 건수로 한 번 줄 세운 뒤,
  // 실제로 화면에 나갈 상위 후보의 가수만 조회한다.
  const prelim = rankResults(recs, q, { title: it => it.title || '', artist: mbArtistOf, popularity: byHits });
  const topNames = [...new Set(prelim.slice(0, 30).map(mbArtistOf).filter(Boolean))].slice(0, 10);
  // 한글 검색어에는 Deezer 유명세를 쓰지 않는다. Deezer의 한국 데이터가 사실상 비어
  // 있어서(버스커 버스커 팬 2명, 임재범 21명, 아이유는 그 이름으로 아예 안 잡힌다)
  // 이걸로 순위를 매기거나 걸러내면 원곡이 무명 커버에게 밀리거나 통째로 잘려 나간다.
  // 그런 검색에서는 MusicBrainz에 몇 건이나 등록됐는지(byHits)가 훨씬 믿을 만하다.
  const korean = HANGUL_RE.test(q);
  const fame = korean ? new Map() : await deezerArtistFame(topNames);
  // 서브요청 예산(요청당 50개) 안에 들도록 6명까지만 대표곡을 확인한다.
  const tops = korean ? new Map()
    : await deezerTopTracks([...fame.values()].map(v => v.id).filter(Boolean).slice(0, 6));

  const ranked = rankResults(recs, q, {
    title: it => it.title || '',
    artist: mbArtistOf,
    album: it => it.releases?.[0]?.title || '',
    popularity: it => {
      const info = fame.get(normalize(mbArtistOf(it)));
      // 팬 수는 0~2천만이라 로그로 눌러 쓴다. 못 구한 가수(조회 실패 또는 Deezer에
      // 없음)는 중립값에서 시작한다 — 낮게 깔면 조회에 성공한 덜 유명한 커버 가수에게
      // 원곡이 밀린다.
      const base = info ? Math.min(Math.log10(info.fans + 1) / 7, 1) : 0.45 + byHits(it) * 0.3;
      // 그 가수의 대표곡이면 확실히 끌어올린다.
      const isSignature = info && tops.get(String(info.id))?.has(normalize(it.title || ''));
      return isSignature ? base + 0.35 : base;
    },
  });

  // 무명 가수의 커버를 걷어낸다. 팬 수를 확인한 가수만 대상이므로, 조회하지 못한
  // 가수는 그대로 남는다. 한글 검색은 위 이유로 아예 거르지 않는다.
  const head = ranked.slice(0, 25);
  const famous = korean ? head : keepFamous(head, it => fame.get(normalize(mbArtistOf(it)))?.fans);
  return famous.slice(0, want).map(mapMusicBrainzRecording);
}

async function mbArtistSearch(q, limit) {
  const { json, want } = await mbSearch('artist', q, limit);
  return rankResults(json.artists || [], q, {
    title: it => it.name || '',
    artist: () => '',
    popularity: mbScore,
  }).slice(0, want).map(a => ({
    artistId: a.id,
    artistName: a.name,
    primaryGenreName: a.disambiguation || a.area?.name || '',
    wrapperType: 'artist',
  }));
}

async function mbAlbumSearch(q, limit) {
  const { json, want } = await mbSearch('release-group', q, limit);
  return rankResults(json['release-groups'] || [], q, {
    title: it => it.title || '',
    artist: it => it['artist-credit']?.[0]?.artist?.name || it['artist-credit']?.[0]?.name || '',
    popularity: mbScore,
  }).slice(0, want).map(rg => ({
    collectionId: rg.id,
    collectionName: rg.title,
    artistName: rg['artist-credit']?.[0]?.artist?.name || rg['artist-credit']?.[0]?.name || '',
    releaseDate: rg['first-release-date'] || '',
    artworkUrl60: caaUrl('release-group', rg.id, 250),
    artworkUrl100: caaUrl('release-group', rg.id, 500),
    trackCount: 0,
    wrapperType: 'collection',
  }));
}

const MB_HEADERS = { 'User-Agent': 'MusicAI/1.0 (https://kjseong0313.github.io)' };

// MusicBrainz는 초당 1회 제한이 빡빡해 503(busy)을 자주 낸다. 잠깐 쉬었다 다시 시도한다.
async function mbJson(url) {
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: MB_HEADERS });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    lastErr = `HTTP ${res.status}: ${text.slice(0, 120)}`;
    if (res.status < 500) break;   // 400대는 다시 걸어도 같은 결과다
    if (i < 2) await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  throw new Error(`MusicBrainz ${lastErr}`);
}

// Deezer는 이 헤더로 카탈로그와 표기 언어를 정한다. ko-KR을 쓰면 한국 카탈로그가 오는데
// 라이선스 때문에 유명 원곡이 통째로 빠져 있어(Ed Sheeran, IU, BTS 등 검색 불가) 쓸 수 없다.
// en-US는 카탈로그가 가장 넓고 가수 이름도 로마자로 온다.
const DEEZER_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' };

// Workers의 fetch는 GET 응답을 엣지에 자동으로 캐싱한다. Deezer가 빈손 응답(위 버그)을
// 한 번 내놓으면 그게 캐시에 박혀서 재시도해도 계속 같은 빈 응답이 돌아온다. 캐시를 끈다.
const DEEZER_FETCH = { headers: DEEZER_HEADERS, cf: { cacheTtl: 0, cacheEverything: false } };

// Deezer 게이트웨이가 간헐적으로 유효한 ID에도 빈 배열을 응답하는 버그가 있어,
// 배열이 비어 있으면 몇 번 재시도한다 (ID 기반 조회는 결과가 진짜로 비어있을 일이 거의 없다).
async function deezerFetchRetry(url, extract) {
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, DEEZER_FETCH);
      const text = await res.text();
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${text.slice(0, 150)}`; }
      else {
        const json = JSON.parse(text);
        if (json.error) { lastErr = `API error: ${JSON.stringify(json.error).slice(0, 150)}`; }
        else {
          const items = extract(json);
          if (items.length) return items;
          lastErr = 'empty response';
        }
      }
    } catch (e) { lastErr = e.message; }
    if (i < 2) await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Deezer: ${lastErr}`);
}

// 가수 -> 앨범 목록 (Deezer)
async function deezerArtistAlbums(id) {
  const items = await deezerFetchRetry(`https://api.deezer.com/artist/${id}/albums?limit=100`, json => json.data || []);
  return items.map(mapDeezerAlbum);
}

// 앨범 -> 트랙 목록 (Deezer)
async function deezerAlbumTracks(id) {
  const items = await deezerFetchRetry(`https://api.deezer.com/album/${id}`, json => json.tracks?.data || []);
  return items.map((t, i) => ({
    trackId: t.id,
    trackName: t.title,
    artistName: t.artist?.name || '',
    trackNumber: t.track_position || i + 1,
    trackTimeMillis: (t.duration || 0) * 1000,
    previewUrl: t.preview || '',
    wrapperType: 'track',
    kind: 'song',
  }));
}

// 가수 -> 앨범 목록 (MusicBrainz release-group)
async function mbArtistAlbums(id) {
  const json = await mbJson(`https://musicbrainz.org/ws/2/release-group?artist=${id}&type=album|ep&fmt=json&limit=100`);
  return (json['release-groups'] || [])
    .map(rg => ({
      collectionId: rg.id,
      collectionName: rg.title,
      releaseDate: rg['first-release-date'] || '',
      artworkUrl60: caaUrl('release-group', rg.id, 250),
      artworkUrl100: caaUrl('release-group', rg.id, 500),
      wrapperType: 'collection',
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}

// 앨범(release-group) -> 트랙 목록 (MusicBrainz)
async function mbAlbumTracks(releaseGroupId) {
  const json = await mbJson(`https://musicbrainz.org/ws/2/release?release-group=${releaseGroupId}&fmt=json&inc=recordings&limit=1`);
  const release = json.releases?.[0];
  if (!release) return [];
  const tracks = [];
  for (const medium of release.media || []) {
    for (const t of medium.tracks || []) {
      tracks.push({
        trackId: t.recording?.id || t.id,
        trackName: t.title || t.recording?.title || '',
        trackNumber: t.position || tracks.length + 1,
        trackTimeMillis: t.length || t.recording?.length || 0,
        wrapperType: 'track',
        kind: 'song',
      });
    }
  }
  return tracks;
}

// 무료 등급 한도. Google의 models.list에는 쿼터 정보가 없어서 AI Studio의 사용량
// 화면(aistudio.google.com/usage)에 표시된 값을 옮겨 적었다. 계정 등급이나 Google
// 정책에 따라 바뀔 수 있으므로 확인 날짜를 함께 내보내 화면에 밝힌다.
// rpm=분당 요청, tpm=분당 토큰, rpd=하루 요청.
const QUOTA_CHECKED_ON = '2026-09-03';
const FREE_QUOTA = {
  'gemini-2.5-flash':       { rpm: 5,  tpm: 250000, rpd: 20 },
  'gemini-2.5-flash-lite':  { rpm: 10, tpm: 250000, rpd: 20 },
  'gemini-3-flash-preview': { rpm: 5,  tpm: 250000, rpd: 20 },
  'gemini-3.1-flash-lite':  { rpm: 15, tpm: 250000, rpd: 500 },
  'gemini-3.5-flash':       { rpm: 5,  tpm: 250000, rpd: 20 },
  'gemini-3.5-flash-lite':  { rpm: 15, tpm: 250000, rpd: 500 },
  'gemini-3.6-flash':       { rpm: 5,  tpm: 250000, rpd: 20 },
  'gemini-3.7-flash':       { rpm: 5,  tpm: 250000, rpd: 20 },
  'gemini-3.8-flash':       { rpm: 5,  tpm: 250000, rpd: 20 },
  // Pro 계열은 무료 등급에서 한도가 0이라 호출해도 막힌다.
  'gemini-2.5-pro':         { rpm: 0,  tpm: 0,      rpd: 0 },
  'gemini-3.1-pro-preview': { rpm: 0,  tpm: 0,      rpd: 0 },
};

// 글 대화용이 아닌 모델들. 이름으로 거른다.
const NON_CHAT_MODEL_RE = /tts|image|nano-banana|transcribe|robotics|computer-use|deep-research|lyria|embedding|aqa|antigravity/i;

// 목록 정렬용 점수. gemini 계열을 먼저, 그 안에서 버전이 높을수록, 같은 버전이면
// preview가 아닌 정식판을 위로 올린다. gemma는 버전 숫자가 4라 그냥 두면 gemini 3.8을
// 제치고 맨 위로 오므로 계열 가중치로 눌러 둔다.
function modelRank(m) {
  const family = /^gemini/.test(m.id) ? 1000 : 0;
  const v = parseFloat((m.id.match(/(\d+\.\d+|\d+)/) || [])[1] || '0');
  const stable = /preview|exp/i.test(m.id) ? 0 : 1;
  const latest = /-latest$/.test(m.id) ? 0.5 : 0;   // 별칭은 구체 버전보다 아래
  return family + v * 10 + stable - latest;
}

// ── 검색 결과 재순위 ──
// Deezer/MusicBrainz는 iTunes만큼 정렬이 좋지 않다(인기 없는 커버·가라오케·다른 언어
// 재발매가 위로 올라온다). 관련도와 인기도를 직접 계산해 다시 정렬한다.
const JAPANESE_RE = /[぀-ヿ]/;
const JUNK_RE = /karaoke|tribute|made popular by|originally performed|as made famous|backing track|instrumental version|8[\s-]?bit|lullaby|various artists|가라오케|노래방|반주/i;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\(.*?\)|\[.*?\]/g, ' ')   // (feat. X), [Remastered] 같은 부가 표기
    .replace(/\bfeat\.?\b.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')   // 구두점 제거 → 표기 차이를 흡수
    .trim();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0(무관) ~ 1(완전 일치). 오타와 단어 생략을 모두 감안한다.
function similarity(q, target) {
  if (!q || !target) return 0;
  if (q === target) return 1;
  // 띄어쓰기를 뺀 것도 같으면 같은 말이다. 한국어는 붙여 쓰기도 띄어 쓰기도 해서
  // "벚꽃엔딩"과 "벚꽃 엔딩"이 다른 문자열로 비교되면 정확히 일치한 무명 커버가 이긴다.
  if (q.replace(/ /g, '') === target.replace(/ /g, '')) return 1;
  if (target.startsWith(q)) return 0.95;   // "bohemian" → "Bohemian Rhapsody"
  if (target.includes(q)) return 0.85;
  const qTokens = q.split(' ').filter(Boolean);
  const tTokens = new Set(target.split(' ').filter(Boolean));
  const hits = qTokens.filter(t => tTokens.has(t)).length;
  const byToken = qTokens.length ? hits / qTokens.length : 0;                      // 단어 생략 허용
  // 오타 허용. 글자 한두 개 차이는 거의 감점하지 않아야 철자가 똑같이 틀린 무명 커버가
  // 원곡을 밀어내지 않는다.
  const byEdit = 1 - editDistance(q, target) / Math.max(q.length, target.length);
  return Math.max(byToken * 0.8, byEdit);
}

// 검색어는 "제목", "가수", "가수 제목" 중 무엇이든 될 수 있어 모두 견줘 최고점을 쓴다.
function relevance(qNorm, title, artist) {
  const t = normalize(title);
  const a = normalize(artist);
  return Math.max(
    similarity(qNorm, t),
    similarity(qNorm, a) * 0.9,
    a && t ? similarity(qNorm, `${a} ${t}`) : 0,
    a && t ? similarity(qNorm, `${t} ${a}`) : 0
  );
}

// 리이슈·모음집임을 제목에 드러내는 낱말들. 숫자는 넣지 않는다 — Adele의 "21", "25"처럼
// 숫자만으로 된 원본 앨범을 리이슈로 오인하기 때문이다.
const REISSUE_RE = /deluxe|edition|anniversary|remaster|expanded|reissue|bonus|collection|compilation|greatest hits|best of|essential|\blive\b|\bhits\b/i;

// 같은 곡이 여러 앨범에 실려 있을 때 어느 쪽을 대표로 보여줄지 고르는 가점·감점.
// 재생수 차이를 뒤집을 만큼 크면 안 된다. 실제 Thriller 사례에서 원본 앨범과
// 25주년판은 동점(둘 다 rank 상한 초과)이고, Number Ones는 0.074, 라이브반은
// 0.141 뒤진다. 그래서 리이슈 감점은 동점만 뒤집고 재생수가 확실히 낮은 판은
// 못 올라오는 0.10으로 잡는다.
function albumAdjust(albumTitle) {
  const t = String(albumTitle || '');
  if (!t) return 0;
  const reissue = REISSUE_RE.test(t) ? -0.10 : 0;          // 중간 세기
  const lengthy = -Math.min(t.length / 2000, 0.02);        // 약하게: 짧은 앨범명 선호
  return reissue + lengthy;
}

// 곡 제목에 붙은 판본 표기. 같은 곡 그룹 안에서 대표를 고를 때만 쓰므로, 진짜 제목에
// 이런 낱말이 들어간 곡이 손해를 보는 일은 없다(그룹 구성원은 모두 같은 곡이다).
const TRACK_VARIANT_RE = /\binst\b|\binst\.|instrumental|remix|\blive\b|acoustic|karaoke|\bedit\b|version|cover|remaster|\bmix\b|반주|노래방/i;

// 앨범을 따져 대표를 다시 고르는 건 화면 위쪽 몇 개면 충분하다.
const ALBUM_PICK_TOP = 5;

// popularity는 0~1로 정규화된 인기도. 관련도가 비슷한 후보들 사이의 순서를 가른다.
// album은 선택 사항 — 주면 같은 곡의 여러 수록 앨범 중 대표를 고르는 데 쓴다.
function rankResults(items, q, { title, artist, popularity, album }) {
  const qNorm = normalize(q);
  const queryIsJapanese = JAPANESE_RE.test(q);
  const queryWantsJunk = JUNK_RE.test(q);

  const scored = items.map(item => {
    const t = title(item) || '';
    const a = artist(item) || '';
    // 관련도가 주(主), 인기도는 비슷한 후보들 사이에서 유명한 쪽을 끌어올리는 역할이다.
    let score = relevance(qNorm, t, a) + (popularity(item) || 0) * 0.45;
    // 걸러내지 않고 점수만 깎는다. 진짜 그것뿐인 검색어면 그대로 보여주는 게 맞다.
    if (!queryWantsJunk && JUNK_RE.test(`${t} ${a}`)) score -= 0.5;
    // 제목만 본다. Cloudflare 엣지가 일본을 경유하면 Deezer가 원곡의 가수 이름을
    // 일본어로 준다("Shape of You — エド・シーラン"). 그건 원곡이므로 감점하면 안 된다.
    if (!queryIsJapanese && JAPANESE_RE.test(t)) score -= 0.35;
    return { item, score };
  });
  // 점수가 같으면 제목이 짧은 쪽을 앞에 둔다. 부가 표기는 정규화 과정에서 지워져 점수가
  // 같아지므로, 이게 없으면 "Yesterday (take 1)"이 그냥 "Yesterday"의 대표로 뽑힌다.
  scored.sort((x, y) => y.score - x.score || String(title(x.item)).length - String(title(y.item)).length);

  // 컴필레이션·재발매 탓에 같은 곡이 여러 번 나오므로 하나만 남긴다.
  const groups = new Map();
  for (const entry of scored) {
    const key = `${normalize(title(entry.item))}|${normalize(artist(entry.item))}`;
    if (groups.has(key)) groups.get(key).push(entry);
    else groups.set(key, [entry]);
  }

  return [...groups.values()].map((members, i) => {
    // 위쪽 몇 곡만 수록 앨범까지 따져 대표를 고른다. Deezer는 같은 곡을 앨범마다 따로
    // 갖고 있어서, 재생수가 같으면 25주년 확장판이 원본 앨범을 밀어내기 때문이다.
    if (!album || i >= ALBUM_PICK_TOP || members.length === 1) return members[0].item;
    let best = members[0], bestScore = -Infinity;
    for (const m of members) {
      // 앨범과 함께 곡 제목도 본다. 이게 없으면 앨범명이 짧다는 이유로 "좋은 날 (inst.)"
      // 같은 판본이 원곡의 대표로 뽑힌다.
      // 판본 감점(0.15)은 리이슈 감점(0.10)보다 크게 잡는다. 곡 자체가 인스트·리믹스인
      // 것이, 원곡이되 모음집에 실린 것보다 나쁘기 때문이다("좋은 날 (inst.)"이 실린
      // REAL보다, "좋은 날"이 실린 Smash Hits 쪽을 보여주는 게 맞다).
      const rawTitle = String(title(m.item));
      const s = m.score + albumAdjust(album(m.item))
              - Math.min(rawTitle.length / 2000, 0.02)
              - (TRACK_VARIANT_RE.test(rawTitle) ? 0.15 : 0);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best.item;
  });
}

const HANGUL_RE = /[가-힣]/;

// 검색어의 낱말이 결과의 제목·가수 어디에도 없으면 엉뚱한 곡을 잡은 것이다
// ("dynamite bts"에 "Dynamite — Taio Cruz"가 나오면 bts가 어디에도 없다).
// 로마자 낱말만 본다 — "lemon 米津玄師"의 결과는 "Kenshi Yonezu"로 로마자 표기라
// 한자·한글 낱말은 표기가 달라도 정답인 경우가 많다.
function coversQuery(q, title, artist) {
  const hay = normalize(`${title} ${artist}`);
  return normalize(q).split(' ')
    .filter(t => /^[a-z0-9]{2,}$/.test(t))
    .every(t => hay.includes(t));
}

// 팬이 이보다 적으면 어떤 검색에서도 듣보로 본다
// (Tanlines 134 / Nara 212 / lushreds 13 / The Liverpool Beat Project 3).
const FANS_FLOOR = 1000;

// 무명 가수의 커버를 걷어낸다. 기준을 절대값으로 잡으면 안 된다 — Deezer는 한국에서
// 점유율이 낮아 이선희·임창정 같은 원곡 가수도 팬 수가 작고, 그러면 원곡이 통째로
// 사라진다. 그래서 그 검색에서 가장 유명한 가수의 1%를 선으로 삼는다.
// 팬 수를 확인하지 못한 항목은 남긴다(조회 실패를 근거로 원곡을 지울 수는 없다).
// 하나도 안 남으면 원래 목록을 그대로 쓴다.
function keepFamous(ranked, fansOf) {
  const known = ranked.map(fansOf).filter(f => typeof f === 'number');
  if (!known.length) return ranked;
  const min = Math.max(Math.max(...known) / 100, FANS_FLOOR);
  const famous = ranked.filter(it => {
    const f = fansOf(it);
    return f === undefined || f >= min;
  });
  return famous.length ? famous : ranked;
}

// Deezer 트랙에는 가수 ID가 들어 있어 팬 수를 정확히 조회할 수 있다(이름으로 찾을 때
// 생기는 동명이인 문제가 없다). 빈 응답 버그 때문에 두 번까지 시도한다.
async function deezerFansById(ids) {
  const fans = new Map();
  await Promise.all([...ids].map(async id => {
    for (let i = 0; i < 2; i++) {
      try {
        const nonce = Math.random().toString(36).slice(2, 8);
        const res = await fetch(`https://api.deezer.com/artist/${id}?_n=${nonce}`, DEEZER_FETCH);
        if (res.ok) {
          const j = await res.json();
          if (typeof j.nb_fan === 'number') { fans.set(String(id), j.nb_fan); return; }
        }
      } catch { /* 아래에서 다시 시도한다 */ }
    }
  }));
  return fans;
}

async function deezerSearch(q, entity, limit, debug) {
  const path = entity === 'album' ? 'search/album' : entity === 'musicArtist' ? 'search/artist' : 'search';
  const want = Number(limit) || 50;
  // 걸러내고 다시 정렬할 재료가 있어야 하므로 필요한 개수보다 넉넉히 받아온다.
  const n = Math.min(want * 2, 100);
  const qs = encodeURIComponent(q);

  // Deezer 게이트웨이는 total>0인데 data를 빈 배열로 주는 버그가 있다. 요청마다 무작위로
  // 터지므로(같은 검색어도 될 때가 있고 안 될 때가 있다) 여러 번 다시 던지는 수밖에 없다.
  // 매번 다른 URL이 되도록 nonce를 붙여, 중간 경로에 빈 응답이 물리지 않게 한다.
  const shapes = [
    `${path}?q=${qs}&limit=${n}&order=RANKING`,
    `${path}?q=${qs}&limit=${n}&index=0`,
    `${path}?q=${qs}&limit=${n + 5}`,
  ];
  // 곡 검색은 전용 엔드포인트가 따로 있어 하나 더 쓸 수 있다.
  if (path === 'search') shapes.push(`search/track?q=${qs}&limit=${n}`);

  // 유명순 정렬이 가능한 소스는 Deezer뿐이라(MusicBrainz는 원곡이 상위 100에도 못 든다)
  // 넉넉히 다시 던진다. 성공한 응답은 이 워커가 30분간 캐싱하므로 비용은 한 번만 든다.
  const ATTEMPTS = 10;
  let lastRaw = '';
  for (let i = 0; i < ATTEMPTS; i++) {
    const shape = shapes[i % shapes.length];
    const nonce = Math.random().toString(36).slice(2, 10);
    const res = await fetch(`https://api.deezer.com/${shape}&_n=${nonce}`, DEEZER_FETCH);
    const text = await res.text();
    if (debug) throw new Error(`RAW [${shape}] status=${res.status}: ${text.slice(0, 400)}`);
    if (!res.ok) { lastRaw = `HTTP ${res.status}: ${text.slice(0, 150)}`; }
    else {
      const json = JSON.parse(text);
      if (json.error) { lastRaw = `API error: ${JSON.stringify(json.error).slice(0, 150)}`; }
      else {
        const items = json.data || [];
        if (items.length || !json.total) {
          const titleOf = it => it.title || it.name || '';
          const artistOf = it => it.artist?.name || '';
          const albumOf = it => it.album?.title || '';
          // 트랙의 rank는 0~약 100만, 가수의 nb_fan은 팬 수다.
          const trackPop = it => entity === 'musicArtist'
            ? Math.min((it.nb_fan || 0) / 5000000, 1)
            : Math.min((it.rank || 0) / 800000, 1);

          // 1차 정렬은 관련도와 재생수로만 한다. 팬 수를 조회할 후보를 추리는 용도다.
          const head = rankResults(items, q, { title: titleOf, artist: artistOf, popularity: trackPop, album: albumOf })
            .slice(0, Math.min(want, 25));
          const mapper = entity === 'album' ? mapDeezerAlbum : entity === 'musicArtist' ? mapDeezerArtist : mapDeezerTrack;
          // rank 100000은 Deezer가 무명 업로드에 주는 최저값이다. 전부 그 값이면 이 지역
          // 카탈로그에 원곡이 없다는 뜻이라(한국 곡에서 흔하다) MusicBrainz 쪽이 낫다.
          const topRank = Math.max(0, ...items.map(it => it.rank || 0));
          const weak = entity === 'song' && items.length > 0 && topRank <= 100000;

          if (entity === 'musicArtist') {   // 가수 검색엔 팬 수가 이미 들어 있다
            return { results: keepFamous(head, it => it.nb_fan).map(mapper), weak };
          }

          // rank는 그 트랙이 얼마나 재생됐는지일 뿐 가수의 유명세가 아니다
          // ("Billie Jean — Sunset Chasers"가 64만인데 팬은 581명이다).
          const ids = [...new Set(head.map(it => it.artist?.id).filter(Boolean))].slice(0, 12);
          const fans = await deezerFansById(ids);
          const fansOf = it => fans.get(String(it.artist?.id));

          // 2차 정렬은 재생수와 가수 유명세를 반씩 본다. 재생수만 보면 같은 제목을 가진 덜
          // 유명한 가수가 원곡을 이기고("yesterday"에서 Hamza가 비틀즈를), 팬 수만 보면 그
          // 곡과 무관하게 팬이 많은 가수가 올라온다(같은 검색에서 Imagine Dragons).
          const ranked = rankResults(head, q, {
            title: titleOf,
            artist: artistOf,
            album: albumOf,
            popularity: it => {
              const f = fansOf(it);
              const fame = f === undefined ? 0.5 : Math.min(Math.log10(f + 1) / 7, 1);
              return trackPop(it) * 0.5 + fame * 0.5;
            },
          });

          // Deezer가 그럴듯한 오답을 내놓는 두 경우를 더 잡아 MusicBrainz로 넘긴다.
          const best = ranked[0];
          const missed = best && !coversQuery(q, titleOf(best), artistOf(best));
          // Deezer의 한국 카탈로그는 신뢰도가 낮다(임재범이 팬 21명으로 잡힌다). 그래서
          // 한글 검색어에는 1위가 확실히 유명한 가수일 때만 Deezer 결과를 인정한다.
          const koreanMiss = best && HANGUL_RE.test(q) && (fansOf(best) || 0) < 100000;
          const badMatch = entity === 'song' && (missed || koreanMiss);

          return { results: keepFamous(ranked, fansOf).map(mapper), weak: weak || badMatch };
        }
        lastRaw = `empty data despite total=${json.total}`;
      }
    }
    // 빈 응답은 시간대를 타서, 한 번 나쁜 구간에 들어가면 몇 초씩 이어진다. 재시도를
    // 촘촘히 몰아치면 그 구간을 통째로 맞고 전부 실패하므로 간격을 점점 넓힌다.
    if (i < ATTEMPTS - 1) await new Promise(r => setTimeout(r, Math.min(150 + i * 180, 900)));
  }
  throw new Error(`Deezer: ${lastRaw}`);
}

export default {
  async fetch(request, env, ctx) {
    // CORS 허용
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);
    const cache = caches.default;

    // ── 사용 가능한 Gemini 모델 목록 (GET) ──
    // 모델이 늘거나 사라져도 앱을 고치지 않도록 Google에서 직접 받아온다.
    if (url.pathname === '/models') {
      const keys = [env.GEMINI_KEY1, env.GEMINI_KEY2].filter(Boolean);
      if (!keys.length) {
        return new Response(JSON.stringify({ error: '환경변수에 키가 없습니다' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      let lastError = '';
      for (const key of keys) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`);
          const json = await res.json();
          if (json.error) { lastError = json.error.message; continue; }
          const models = (json.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => ({
              id: String(m.name || '').replace(/^models\//, ''),
              label: m.displayName || '',
              desc: m.description || '',
              inputLimit: m.inputTokenLimit || 0,
              outputLimit: m.outputTokenLimit || 0,
              thinking: m.thinking === true,
              quota: FREE_QUOTA[String(m.name || '').replace(/^models\//, '')] || null,
            }))
            // 이 앱은 글로 묻고 답하는 데만 쓴다. 음성·이미지·영상 전용, 로봇·컴퓨터 조작,
            // 딥리서치처럼 용도가 다른 모델은 목록에서 뺀다(고르면 오류만 난다).
            .filter(m => !NON_CHAT_MODEL_RE.test(m.id))
            // 하루 한도가 큰 모델을 위로 올린다. 무료로 쓸 때 실제로 중요한 건 버전보다
            // 하루에 몇 번 부를 수 있느냐다(Lite는 500회, 나머지는 20회).
            .sort((a, b) => (b.quota?.rpd || 0) - (a.quota?.rpd || 0) || modelRank(b) - modelRank(a));
          const response = new Response(JSON.stringify({ models, quotaCheckedOn: QUOTA_CHECKED_ON }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=21600'
            }
          });
          if (models.length) ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        } catch (e) { lastError = e.message; }
      }
      return new Response(JSON.stringify({ error: lastError }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // ── iTunes 검색 프록시 (GET) ──
    if (url.pathname === '/itunes') {
      const q = (url.searchParams.get('q') || '').trim();
      const entity = url.searchParams.get('entity') || 'song';
      const country = url.searchParams.get('country') || 'KR';
      const limit = url.searchParams.get('limit') || '50';

      if (!q) {
        return new Response(JSON.stringify({ error: '검색어가 없습니다' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=${entity}&limit=${limit}&country=${country}`;
      // Apple은 Cloudflare 공용 IP를 상시 429로 막는다(직접 확인). 재시도해도 같은 IP라
      // 소용이 없어 한 번만 걸어 본다 — 언젠가 풀릴 수 있으니 호출 자체는 남겨 둔다.
      const { data: appleData, error: appleError } = await fetchItunesJson(itunesUrl, 1);

      let data;
      const errs = [];
      if (!appleError && appleData?.results?.length) {
        data = { ...appleData, source: 'iTunes' };
      } else {
        appleError && errs.push(`iTunes: ${appleError}`);
        const debug = url.searchParams.get('debug') === '1';
        // 유명한 게 하나도 안 잡힌 Deezer 결과. MusicBrainz가 실패할 때만 쓴다.
        let weakDeezer = null;
        try {
          const { results, weak } = await deezerSearch(q, entity, limit, debug);
          // Deezer는 지역 카탈로그에 곡이 없으면 오류 없이 빈손으로 성공한다. 그대로
          // "결과 없음"을 돌려주지 말고 MusicBrainz까지 가봐야 한다(원곡이 거기 있다).
          if (!results.length) errs.push('Deezer: 결과 없음');
          else if (weak) { weakDeezer = results; errs.push('Deezer: 유명한 결과 없음'); }
          else data = { resultCount: results.length, results, source: 'Deezer' };
        } catch (e) {
          errs.push(e.message);
          // debug 모드에서는 Deezer 응답을 그대로 봐야 하므로 폴백으로 넘어가지 않는다.
          if (debug) {
            return new Response(JSON.stringify({ error: e.message }), {
              status: 502,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }
        }

        if (!data) {
          try {
            const results = entity === 'musicArtist' ? await mbArtistSearch(q, limit)
              : entity === 'album' ? await mbAlbumSearch(q, limit)
              : await musicBrainzSearch(q, limit);
            if (results.length) data = { resultCount: results.length, results, source: 'MusicBrainz' };
            else errs.push('MusicBrainz: 결과 없음');
          } catch (e2) {
            errs.push(`MusicBrainz: ${e2.message}`);
          }
        }

        // 어느 쪽도 못 건졌으면 아까 밀어둔 Deezer 결과라도 보여준다.
        if (!data && weakDeezer) {
          data = { resultCount: weakDeezer.length, results: weakDeezer, source: 'Deezer' };
        }
      }

      if (!data) {
        return new Response(JSON.stringify({ error: errs.join(' | ') }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const response = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1800'
        }
      });
      if (data.results?.length) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // ── Deezer/MusicBrainz 출처 결과의 가수→앨범, 앨범→트랙 조회 (GET) ──
    const browseRoutes = {
      '/deezer-artist-albums': () => deezerArtistAlbums(url.searchParams.get('id')),
      '/deezer-album-tracks': () => deezerAlbumTracks(url.searchParams.get('id')),
      '/mb-artist-albums': () => mbArtistAlbums(url.searchParams.get('id')),
      '/mb-album-tracks': () => mbAlbumTracks(url.searchParams.get('id')),
    };
    if (browseRoutes[url.pathname]) {
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const results = await browseRoutes[url.pathname]();
        const response = new Response(JSON.stringify({ results }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=1800'
          }
        });
        if (results.length) ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ── iTunes lookup 프록시 (GET) ──
    if (url.pathname === '/itunes-lookup') {
      const id = url.searchParams.get('id');
      const entity = url.searchParams.get('entity') || 'song';
      const country = url.searchParams.get('country') || 'US';
      const limit = url.searchParams.get('limit') || '200';

      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const lookupUrl = `https://itunes.apple.com/lookup?id=${id}&entity=${entity}&country=${country}&limit=${limit}`;
      const { data, error } = await fetchItunesJson(lookupUrl);
      if (error) {
        return new Response(JSON.stringify({ error }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const response = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1800'
        }
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // ── Gemini 프록시 (POST) ──
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: { message: '잘못된 요청 형식입니다' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 모델명이 그대로 URL 경로에 들어가므로 형식을 확인한다.
    if (!/^[\w.-]+$/.test(body.model || '')) {
      return new Response(JSON.stringify({ error: { message: '알 수 없는 모델입니다' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const keys = [env.GEMINI_KEY1, env.GEMINI_KEY2].filter(Boolean);

    if (keys.length === 0) {
      return new Response(JSON.stringify({ error: { message: '환경변수에 키가 없습니다' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let lastError = '';
    for (const key of keys) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body.payload)
          }
        );
        const data = await res.json();
        if (data.error?.code === 429) { lastError = '429'; continue; }
        if (data.error) { lastError = data.error.message; continue; }
        return new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch(e) {
        lastError = e.message;
      }
    }

    return new Response(JSON.stringify({ error: { message: '실패: ' + lastError } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};

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
  return String(q || '').split(/\s+/).filter(Boolean)
    // ~1(편집 거리 1)로 조인다. rapsody→rhapsody 같은 한 글자 오타는 그대로 잡으면서
    // 기본값 ~2가 jean에 joan·sean·dean까지 끌어오는 잡음을 줄인다.
    .map(t => /^[A-Za-z0-9]{4,}$/.test(t) ? `${t}~1` : escapeLucene(t))
    .join(' ');
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
          if (exact.length) { fame.set(want, Math.max(...exact.map(a => a.nb_fan || 0))); return; }
          // 이름이 정확히 겹치는 가수가 진짜 없으면 다시 걸어도 결과가 같다.
          if ((json.data || []).length) return;
        }
      } catch { /* 아래에서 다시 시도한다 */ }
    }
    /* 끝내 못 구하면 이 가수는 빈도 신호로만 판단한다 */
  }));
  return fame;
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
  const fame = await deezerArtistFame(topNames);

  const ranked = rankResults(recs, q, {
    title: it => it.title || '',
    artist: mbArtistOf,
    popularity: it => {
      const key = normalize(mbArtistOf(it));
      const fans = fame.get(key);
      // 팬 수는 0~2천만이라 로그로 눌러 쓴다.
      if (fans !== undefined) return Math.min(Math.log10(fans + 1) / 7, 1);
      // 팬 수를 못 구한 가수(조회 실패 또는 Deezer에 없음)는 중립값에서 시작한다.
      // 낮게 깔면 조회에 성공한 덜 유명한 커버 가수에게 원곡이 밀린다.
      return 0.45 + byHits(it) * 0.3;
    },
  });

  // 무명 가수의 커버를 걷어낸다. 팬 수를 확인한 가수만 대상이므로, 조회하지 못한
  // 가수는 그대로 남는다.
  const famous = keepFamous(ranked.slice(0, 25), it => fame.get(normalize(mbArtistOf(it))));
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

// ── 검색 결과 재순위 ──
// Deezer/MusicBrainz는 iTunes만큼 정렬이 좋지 않다(인기 없는 커버·가라오케·다른 언어
// 재발매가 위로 올라온다). 관련도와 인기도를 직접 계산해 다시 정렬한다.
const JAPANESE_RE = /[぀-ヿ]/;
const JUNK_RE = /karaoke|tribute|made popular by|originally performed|as made famous|backing track|instrumental version|8[\s-]?bit|lullaby|가라오케|노래방|반주/i;

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

// popularity는 0~1로 정규화된 인기도. 관련도가 비슷한 후보들 사이의 순서를 가른다.
function rankResults(items, q, { title, artist, popularity }) {
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

  // 컴필레이션·재발매 탓에 같은 곡이 여러 번 나오므로 점수가 높은 쪽만 남긴다.
  const seen = new Set();
  const out = [];
  for (const { item } of scored) {
    const key = `${normalize(title(item))}|${normalize(artist(item))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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
          // 트랙의 rank는 0~약 100만, 가수의 nb_fan은 팬 수다.
          const trackPop = it => entity === 'musicArtist'
            ? Math.min((it.nb_fan || 0) / 5000000, 1)
            : Math.min((it.rank || 0) / 800000, 1);

          // 1차 정렬은 관련도와 재생수로만 한다. 팬 수를 조회할 후보를 추리는 용도다.
          const head = rankResults(items, q, { title: titleOf, artist: artistOf, popularity: trackPop })
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
            popularity: it => {
              const f = fansOf(it);
              const fame = f === undefined ? 0.5 : Math.min(Math.log10(f + 1) / 7, 1);
              return trackPop(it) * 0.5 + fame * 0.5;
            },
          });
          return { results: keepFamous(ranked, fansOf).map(mapper), weak };
        }
        lastRaw = `empty data despite total=${json.total}`;
      }
    }
    if (i < ATTEMPTS - 1) await new Promise(r => setTimeout(r, 150));
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

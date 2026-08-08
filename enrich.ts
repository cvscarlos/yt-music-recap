#!/usr/bin/env node
// Fill in artists for tracks whose Takeout channel is a placeholder rather than a name,
// and record how long each track runs and which song it holds.
//
//   node enrich.ts            look everything up, write artists.json
//   node enrich.ts --selftest
//
// YouTube answers first, by video ID, from the credits its label supplied — exact, and so
// needing nobody to confirm it. Deezer and iTunes answer only for what is left, and only
// from a title, so they must agree with each other before their answer is taken. A wrong
// artist is worse than a missing one, and anything still doubtful is simply left alone.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

// Node reads .env itself, so no dotenv dependency. Throws when the file is absent, which
// is fine — the key can equally come from the environment, and without one this falls
// back to catalogue search.
try {
  process.loadEnvFile();
} catch {}

// Channel names YouTube substitutes when a track has no artist of its own. Anything else
// came from a real "- Topic" channel and is left alone: correcting a name Takeout already
// gave us risks replacing a right answer with a famous same-named artist.
const PLACEHOLDERS = new Set(["Release", "Music Library Uploads", "Various Artists", ""]);

// Strips punctuation and accents while keeping letters and digits of every script. Matching
// on Latin characters alone would erase a Japanese, Cyrillic, Greek or Arabic value down to
// an empty string, and empty strings compare equal to each other — so unrelated titles look
// identical and unrelated artists look like two sources agreeing.
const foldText = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// For comparing a search result against what was asked for: also discards the qualifiers a
// catalogue adds to a title, which the asked-for title will not have.
export const normalize = (s: string) =>
  foldText(
    s
      .replace(/\(.*?\)|\[.*?\]/g, " ") // drop "(Remix)", "[Official Video]"
      .replace(/\b(?:feat|ft|featuring|with)\b.*$/i, " "),
  );

// Identifies a song, so its studio take, its live take and a reissue on a compilation all
// answer to one name. Version qualifiers live in brackets — "(Live In Texas)", "(Ao Vivo)",
// "(Bass Boosted)" — so removing every bracket separates the song from the version of it
// without knowing any of those words, in any language. The album is deliberately excluded:
// versions of one song differ on it, which would put each of them under its own key.

export const songKey = (title: string, artist: string) => {
  const song = foldText(title.replace(/[(\[][^)\]]*[)\]]/g, " "));
  // A title made only of punctuation leaves nothing to match on, and treating that as a
  // key would merge every such video together.
  return song ? `${song} · ${foldText(artist)}` : "";
};

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Guards against a search returning a different song that merely ranks well for the query.
// Transliterated titles differ by a character or two ("Zetsubo" vs "Zetsubou"), so exact
// comparison is too strict. Two limits together keep the tolerance honest: a similarity
// floor, which unrelated short titles fail ("Amor" and "Ator" are one edit apart but only
// 75% alike), and a hard ceiling of two edits, so a long title cannot drift into another
// song on percentage alone.
export function titlesMatch(query: string, found: string): boolean {
  const [a, b] = [normalize(query), normalize(found)];
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.includes(short)) return short.length / long.length >= 0.6;
  const distance = editDistance(a, b);
  return distance <= 2 && 1 - distance / long.length >= 0.8;
}

type Candidate = { artist: string; title: string } | null;

// Tracks YouTube generates for a label carry their credits in the description:
//
//   Provided to YouTube by Universal Music Group
//
//   Vai Pagar Caro Por Me Conhecer · Gloria
//   Gloria
//
// The artist is stated for this exact video, so no title guessing is involved and a band
// cannot lose its song to a famous act with the same name. Everything else is a fallback.
export function parseArtTrack(description: string): { title: string; artist: string; album: string } | null {
  // Nothing here keys off an English phrase. "Provided to YouTube by" and "Auto-generated
  // by YouTube" are both translated, so this anchors on the two things that are not: the
  // ℗ phonogram symbol every such description carries, and the "·" separating credits.
  if (!description.includes("℗")) return null;
  const lines = description.split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => /^[^·]+ · [^·]/.test(l));
  if (at === -1) return null;

  const [title, ...artists] = lines[at].split(" · ");
  if (!artists.length) return null;
  // The album is the next non-empty line, unless the credits are the last thing stated.
  const album = lines.slice(at + 1).find((l) => l && !l.startsWith("℗")) ?? "";
  return { title, artist: artists.join(", "), album };
}

// "PT3M22S" -> 202. Hours appear on long uploads, and a bare "PT0S" on live streams.
export function parseDuration(iso: string): number | null {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds || null;
}

// One request covers 50 videos and costs a single quota unit whatever it asks for, so
// credits and durations come back together at no extra cost.
async function youtubeLookup(ids: string[], key: string) {
  const artists = new Map<string, string>();
  const durations = new Map<string, number>();
  const recordings = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${batch.join(",")}&key=${key}`,
    );
    if (!r.ok) {
      console.error(`  YouTube API returned ${r.status} — falling back to catalogue search.`);
      break;
    }
    // Private uploads and deleted videos are simply absent from the response.
    for (const item of ((await r.json()) as any).items ?? []) {
      const credits = parseArtTrack(item.snippet?.description ?? "");
      if (credits) {
        artists.set(item.id, credits.artist);
        const key = songKey(credits.title, credits.artist);
        if (key) recordings.set(item.id, key);
      }
      const seconds = parseDuration(item.contentDetails?.duration ?? "");
      if (seconds) durations.set(item.id, seconds);
    }
  }
  return { artists, durations, recordings };
}

// YouTube titles often carry the artist as well ("Celldweller feat. X - Shapeshifter"), so
// searching the whole string returns nothing. Fall back to the text after the last dash,
// which is where the song title sits in that convention.
export function queryVariants(title: string): string[] {
  const parts = title.split(/\s+-\s+/);
  return parts.length > 1 ? [title, parts[parts.length - 1]] : [title];
}

// Searching a shortened query throws away the words that disambiguate it, and a famous
// song frequently occupies the bare title: "Celldweller ... - Shapeshifter" cut down to
// "Shapeshifter" returns Lorde from both catalogues at once, so even agreement between
// them proves nothing. A shortened query is therefore only trusted when the artist it
// returns is named in the full title — which is exactly the premise for splitting it.
export function plausibleArtist(fullTitle: string, query: string, artist: string): boolean {
  if (query === fullTitle) return true;
  return normalize(fullTitle).includes(normalize(artist));
}

async function deezer(title: string): Promise<Candidate> {
  for (const q of queryVariants(title)) {
    const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
    // Refusing to answer is not the same as answering "no such track". Throwing keeps the
    // difference, so a rate limit or an outage is never recorded as a settled result.
    if (!r.ok) throw new Error(`search returned ${r.status}`);
    const hit = ((await r.json()) as any).data?.find(
      (d: any) => titlesMatch(q, d.title) && plausibleArtist(title, q, d.artist.name),
    );
    if (hit) return { artist: hit.artist.name, title: hit.title };
  }
  return null;
}

async function itunes(title: string): Promise<Candidate> {
  for (const q of queryVariants(title)) {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=5`);
    // Refusing to answer is not the same as answering "no such track". Throwing keeps the
    // difference, so a rate limit or an outage is never recorded as a settled result.
    if (!r.ok) throw new Error(`search returned ${r.status}`);
    const hit = ((await r.json()) as any).results?.find(
      (x: any) => titlesMatch(q, x.trackName) && plausibleArtist(title, q, x.artistName),
    );
    if (hit) return { artist: hit.artistName, title: hit.trackName };
  }
  return null;
}

const loadCache = <T,>(file: string): Record<string, T> =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

// What the recaps still need answered. Reading the recaps rather than the history means
// only tracks that already charted are looked up.
function collectWork(
  store: Record<string, string | null>,
  lengths: Record<string, number>,
  recordings: Record<string, string>,
) {
  const todo = new Map<string, string>();
  // One request answers length and song together, so a video is worth asking about when
  // either is missing. Checking only lengths left a deleted or half-written recordings
  // cache unrepairable, since nothing would ever ask about those videos again.
  const needLookup = new Set<string>();
  for (const f of readdirSync("out").filter((x) => x.endsWith(".json"))) {
    for (const t of JSON.parse(readFileSync(`out/${f}`, "utf8"))) {
      if (PLACEHOLDERS.has(t.artist) && !(t.videoId in store)) todo.set(t.videoId, t.title);
      if (!(t.videoId in lengths) || !(t.videoId in recordings)) needLookup.add(t.videoId);
    }
  }
  return { todo, needLookup: [...needLookup] };
}

type Tally = { fromYouTube: number; agreed: number; youtubeOnly: number; unanswered: number; total: number };
const ambiguous = (t: Tally) => t.total - t.fromYouTube - t.agreed - t.youtubeOnly - t.unanswered;

function writeReview(tally: Tally, rows: string[]) {
  writeFileSync(
    "out/artists-review.md",
    [
      `# Artist lookup review`,
      ``,
      `Of ${tally.total} tracks: **${tally.fromYouTube} stated by YouTube**, **${tally.agreed} agreed by both catalogues**, **${tally.youtubeOnly} exist only on YouTube**, **${ambiguous(tally)} still ambiguous**.`,
      ``,
      `Rows marked *from YouTube* come from the label's own credits for that video ID, so they need no checking.`,
      ``,
      `YouTube-only tracks are mashups, meme edits and personal uploads that no catalogue carries. They are recorded as resolved so they are not looked up again — they keep the channel name Takeout gave them.`,
      ``,
      `Ambiguous rows are left alone and keep their channel name; nothing downstream waits on them. To override one anyway, add it to artists.json as \`"videoId": "Artist"\` — hand edits are never overwritten.`,
      ``,
      `| Track | Deezer | iTunes | Verdict | Video |`,
      `| --- | --- | --- | --- | --- |`,
      ...rows,
      ``,
    ].join("\n"),
  );
}

async function main() {
  // Every recap shares one artist store, so a track resolved for 2025 is already fixed for
  // 2026, and existing entries are kept because a human may have corrected them by hand. A
  // null value records a track that exists only on YouTube — a mashup, a meme edit, a
  // personal upload — which is a real answer, and storing it stops the track being asked
  // about again. Lengths and songs are cached apart from it: they never need correcting.
  const store = loadCache<string | null>("artists.json");
  const lengths = loadCache<number>("durations.json");
  const recordings = loadCache<string>("recordings.json");

  const { todo, needLookup } = collectWork(store, lengths, recordings);
  const key = process.env.YOUTUBE_API_KEY;
  if (!todo.size && !needLookup.length) {
    console.log("Nothing to look up — every track already has an artist and a length.");
    return;
  }

  // Ask YouTube first. It answers by video ID rather than by title, so its answers need no
  // human confirmation — which is what lets this run unattended on someone else's history.
  // One pass covers both questions: the tracks missing an artist are a subset of these.
  let authoritative = new Map<string, string>();
  if (key) {
    console.log(`Asking YouTube about ${needLookup.length} videos (${Math.ceil(needLookup.length / 50)} requests)...`);
    const got = await youtubeLookup(needLookup, key);
    authoritative = got.artists;
    for (const [id, seconds] of got.durations) lengths[id] = seconds;
    for (const [id, recording] of got.recordings) recordings[id] = recording;
    writeFileSync("durations.json", JSON.stringify(lengths, null, 2) + "\n");
    writeFileSync("recordings.json", JSON.stringify(recordings, null, 2) + "\n");
    console.log(`  ${got.durations.size} track lengths and ${got.recordings.size} recordings cached.\n`);
  } else {
    console.log("  YOUTUBE_API_KEY is not set — using catalogue search only, which needs review.\n");
  }

  if (!todo.size) {
    console.log("Every track already has an artist.");
    return;
  }
  console.log(`Resolving ${todo.size} tracks with a placeholder artist...\n`);

  const rows: string[] = [];
  const tally: Tally = { fromYouTube: 0, agreed: 0, youtubeOnly: 0, unanswered: 0, total: todo.size };
  for (const [videoId, title] of todo) {
    const stated = authoritative.get(videoId);
    if (stated) {
      store[videoId] = stated;
      tally.fromYouTube++;
      console.log(`  ${`YOUTUBE  ${stated}`.padEnd(46)} ${title.slice(0, 50)}`);
      rows.push(`| ${title.replace(/\|/g, "/")} | ${stated} | — | **from YouTube** | ${videoId} |`);
      continue;
    }
    let unanswered = false;
    const ask = (search: Promise<Candidate>) =>
      search.catch(() => {
        unanswered = true;
        return null;
      });
    const [dz, it] = await Promise.all([ask(deezer(title)), ask(itunes(title))]);
    await new Promise((done) => setTimeout(done, 350)); // iTunes throttles near 20/minute

    // Two sources naming the same artist is the whole basis for trusting either of them,
    // so a comparison of two blanks must not pass for it.
    const same = dz && it && normalize(dz.artist) && normalize(dz.artist) === normalize(it.artist);
    let verdict: string;
    if (same) {
      store[videoId] = dz!.artist;
      tally.agreed++;
      verdict = `AGREED  ${dz!.artist}`;
    } else if (unanswered) {
      // A search that could not run tells us nothing, and recording nothing as an answer
      // would close the question forever. Left out of the store so the next run retries.
      tally.unanswered++;
      verdict = `NOT REACHED  (retry later)`;
    } else if (!dz && !it) {
      // Both searched and neither has it under any spelling, so it is native to YouTube.
      store[videoId] = null;
      tally.youtubeOnly++;
      verdict = `YOUTUBE-ONLY`;
    } else {
      verdict = `REVIEW  deezer=${dz?.artist ?? "—"}  itunes=${it?.artist ?? "—"}`;
    }
    console.log(`  ${verdict.padEnd(46)} ${title.slice(0, 50)}`);
    rows.push(`| ${title.replace(/\|/g, "/")} | ${dz?.artist ?? "—"} | ${it?.artist ?? "—"} | ${same ? "**agreed**" : !dz && !it ? "YouTube-only" : "review"} | ${videoId} |`);
  }

  writeFileSync("artists.json", JSON.stringify(store, null, 2) + "\n");
  writeReview(tally, rows);
  console.log(
    `\n${tally.fromYouTube} from YouTube, ${tally.agreed} agreed by catalogues, ` +
      `${tally.youtubeOnly} YouTube-only, ${ambiguous(tally)} left ambiguous. See out/artists-review.md.`,
  );
}

function selftest() {
  assert.ok(titlesMatch("Rosenrot", "Rosenrot (Album Version)"), "ignores bracketed suffixes");
  assert.ok(titlesMatch("É Só Você Lembrar", "E So Voce Lembrar"), "ignores accents");
  assert.ok(!titlesMatch("Metade", "Minha Metade Perfeita Do Amor"), "a title buried in a longer one is not that title");
  assert.ok(!titlesMatch("Anemia", "Academia"), "similar-looking but different titles do not match");
  assert.ok(PLACEHOLDERS.has("Release") && !PLACEHOLDERS.has("Gloria"), "a real artist is never looked up");

  // Fuzzy tolerance: wide enough for transliteration, narrow enough to reject near-misses.
  assert.ok(titlesMatch("Zetsubo Billy", "Zetsubou Billy"), "absorbs a transliteration variant");
  assert.ok(titlesMatch("Sonne", "Sonnne"), "absorbs a typo in a short title");
  assert.ok(!titlesMatch("Sonne", "Sonho"), "two edits in a short title is a different song");
  assert.ok(!titlesMatch("Amor", "Ator"), "very short titles stay strict");
  assert.ok(!titlesMatch("Gloria", "Gloria Estefan"), "an artist name appended is not the same title");

  // Matching on Latin characters alone reduced these to empty strings, which made every
  // non-Latin title unmatchable and every pair of non-Latin artists look like agreement.
  assert.ok(titlesMatch("一輪の花", "一輪の花"), "a non-Latin title matches itself");
  assert.ok(titlesMatch("Зачем", "Зачем"), "and so does a Cyrillic one");
  assert.notEqual(normalize("高橋洋子"), normalize("残酷な天使"), "two non-Latin artists are not the same artist");
  assert.ok(normalize("一輪の花"), "a non-Latin value does not normalize away to nothing");

  assert.deepEqual(queryVariants("Celldweller feat. X - Shapeshifter"), ["Celldweller feat. X - Shapeshifter", "Shapeshifter"], "falls back to the text after the dash");
  assert.deepEqual(queryVariants("Bodies"), ["Bodies"], "a plain title is searched once");

  const cell = "Celldweller feat. Styles Of Beyond - Shapeshifter";
  assert.ok(!plausibleArtist(cell, "Shapeshifter", "Lorde"), "rejects a famous song that took over the shortened query");
  assert.ok(plausibleArtist(cell, "Shapeshifter", "Celldweller"), "accepts the artist actually named in the title");
  assert.ok(plausibleArtist("Bodies", "Bodies", "Drowning Pool"), "an unshortened query needs no corroboration");

  // Real description text, as returned for these video IDs.
  assert.deepEqual(
    parseArtTrack("Provided to YouTube by Universal Music Group\n\nBodies · Drowning Pool\n\nSinner\n\n℗ 2001 Craft Recordings\n\nReleased on: 2001-01-01"),
    { title: "Bodies", artist: "Drowning Pool", album: "Sinner" },
    "reads what the label stated for this video",
  );
  assert.equal(
    parseArtTrack("Provided to YouTube by Lujo Network\n\nTrava na Pose (feat. Mc Rennan) · DJ Patrick Muniz · Dj Olliver · Mc Topre\n\nTrava na Pose\n\n℗ Lujo")?.artist,
    "DJ Patrick Muniz, Dj Olliver, Mc Topre",
    "keeps every credited artist",
  );
  // The surrounding prose is translated for non-English accounts; the ℗ and the · are not.
  assert.equal(
    parseArtTrack("Bereitgestellt von Universal Music Group\n\nSonne · Rammstein\n\nMutter\n\n℗ 2001 Universal")?.album,
    "Mutter",
    "does not depend on the description being English",
  );
  assert.equal(parseArtTrack("a normal upload · with a stray dot but no phonogram mark"), null, "an ordinary description is not mistaken for credits");
  assert.equal(parseArtTrack(""), null, "an empty description resolves to nothing");

  assert.equal(songKey("Só Eu Sei?", "Gloria"), songKey("Só Eu Sei", "Gloria"), "punctuation does not make a second song");
  assert.equal(songKey("Papercut (Live In Texas)", "Linkin Park"), songKey("Papercut", "Linkin Park"), "a live take is the same song");
  // The same holds in any language, because no language is consulted.
  assert.equal(songKey("Anjo Bom (Ao Vivo)", "Amado Batista"), songKey("Anjo Bom", "Amado Batista"), "Portuguese");
  assert.equal(songKey("Sonne (Live aus Berlin)", "Rammstein"), songKey("Sonne", "Rammstein"), "German");
  assert.equal(songKey("一輪の花 (ライブ)", "高橋洋子"), songKey("一輪の花", "高橋洋子"), "Japanese");

  assert.notEqual(songKey("Papercut", "Linkin Park"), songKey("Papercut", "Anberlin"), "a different artist is a different song");
  assert.notEqual(songKey("Numb", "Linkin Park"), songKey("Numb Encore", "Linkin Park"), "a different title is a different song");
  // Non-Latin titles must survive folding. Stripping them would leave every such song
  // sharing one empty key, quietly merging songs that have nothing to do with each other.
  assert.notEqual(songKey("一輪の花", "高橋洋子"), songKey("残酷な天使のテーゼ", "高橋洋子"), "two Japanese titles stay distinct");
  assert.notEqual(songKey("Зачем", "xolair"), songKey("Прощай", "xolair"), "two Cyrillic titles stay distinct");
  assert.ok(songKey("一輪の花", "高橋洋子").startsWith("一輪の花"), "a Japanese title survives folding");
  assert.equal(songKey("???", "Some Artist"), "", "a title with nothing to match on yields no key at all");

  assert.equal(parseDuration("PT3M22S"), 202, "minutes and seconds");
  assert.equal(parseDuration("PT1H2M3S"), 3723, "hours on a long upload");
  assert.equal(parseDuration("PT45S"), 45, "seconds only");
  assert.equal(parseDuration("PT0S"), null, "a zero length is no length at all");
  assert.equal(parseDuration("nonsense"), null, "unparseable input yields nothing");
  console.log("selftest ok");
}

// Only act when run directly. Importing this module — a test, another script — must not
// spend API quota as a side effect.
if (import.meta.filename === process.argv[1]) {
  if (process.argv.includes("--selftest")) selftest();
  else await main();
}

#!/usr/bin/env node
// Fill in artists for tracks whose Takeout channel is a placeholder rather than a name.
// Deezer and iTunes are both keyless, so this needs no account and no API key.
//
//   node enrich.ts            look everything up, write artists.json
//   node enrich.ts --selftest
//
// Only agreed matches are written. Everything else lands in a review file for a human,
// because a wrong artist is worse than a missing one.

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

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents so "É Só" matches "e so"
    .replace(/\(.*?\)|\[.*?\]/g, "") // drop "(Remix)", "[Official Video]"
    .replace(/\b(feat|ft|featuring|with)\b.*$/, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
export function parseArtTrack(description: string): string | null {
  const lines = description.split("\n").map((l) => l.trim());
  const header = lines.findIndex((l) => l.startsWith("Provided to YouTube by"));
  if (header === -1) return null;
  const credits = lines.slice(header + 1).find((l) => l.includes(" · "));
  if (!credits) return null;
  const artists = credits.split(" · ").slice(1); // first field is the song title
  return artists.length ? artists.join(", ") : null;
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
      const artist = parseArtTrack(item.snippet?.description ?? "");
      if (artist) artists.set(item.id, artist);
      const seconds = parseDuration(item.contentDetails?.duration ?? "");
      if (seconds) durations.set(item.id, seconds);
    }
  }
  return { artists, durations };
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
    if (!r.ok) continue;
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
    if (!r.ok) continue;
    const hit = ((await r.json()) as any).results?.find(
      (x: any) => titlesMatch(q, x.trackName) && plausibleArtist(title, q, x.artistName),
    );
    if (hit) return { artist: hit.artistName, title: hit.trackName };
  }
  return null;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
  // Every recap shares one artist store, so a track resolved for 2025 is already fixed
  // for 2026. Existing entries are kept: a human may have corrected them by hand.
  //
  // A null value records a track that exists only on YouTube — a mashup, a meme edit, a
  // personal upload. That is a real answer, not a failed one, and storing it stops the
  // track being queried again on every future run.
  const store: Record<string, string | null> = existsSync("artists.json")
    ? JSON.parse(readFileSync("artists.json", "utf8"))
    : {};

  // Track lengths turn a play count into listening time, which is what a Recap actually
  // shows. They are cached separately because they never change, while an artist might be
  // corrected by hand.
  const lengths: Record<string, number> = existsSync("durations.json")
    ? JSON.parse(readFileSync("durations.json", "utf8"))
    : {};

  const todo = new Map<string, string>();
  const needLength: string[] = [];
  for (const f of readdirSync("out").filter((x) => x.endsWith(".json"))) {
    for (const t of JSON.parse(readFileSync(`out/${f}`, "utf8"))) {
      if (PLACEHOLDERS.has(t.artist) && !(t.videoId in store)) todo.set(t.videoId, t.title);
      if (!(t.videoId in lengths) && !needLength.includes(t.videoId)) needLength.push(t.videoId);
    }
  }

  const key = process.env.YOUTUBE_API_KEY;
  if (!todo.size && !needLength.length) {
    console.log("Nothing to look up — every track already has an artist and a length.");
    return;
  }

  // Ask YouTube first. It answers by video ID rather than by title, so its answers need no
  // human confirmation — which is what lets this run unattended on someone else's history.
  // One pass covers both questions: the tracks missing an artist are a subset of these.
  let authoritative = new Map<string, string>();
  if (key) {
    console.log(`Asking YouTube about ${needLength.length} videos (${Math.ceil(needLength.length / 50)} requests)...`);
    const got = await youtubeLookup(needLength, key);
    authoritative = got.artists;
    for (const [id, seconds] of got.durations) lengths[id] = seconds;
    writeFileSync("durations.json", JSON.stringify(lengths, null, 2) + "\n");
    console.log(`  ${got.durations.size} track lengths cached.\n`);
  } else {
    console.log("  YOUTUBE_API_KEY is not set — using catalogue search only, which needs review.\n");
  }

  if (!todo.size) {
    console.log("Every track already has an artist.");
    return;
  }
  console.log(`Resolving ${todo.size} tracks with a placeholder artist...\n`);

  const rows: string[] = [];
  let fromYouTube = 0;
  let agreed = 0;
  let youtubeOnly = 0;
  for (const [videoId, title] of todo) {
    const stated = authoritative.get(videoId);
    if (stated) {
      store[videoId] = stated;
      fromYouTube++;
      console.log(`  ${`YOUTUBE  ${stated}`.padEnd(46)} ${title.slice(0, 50)}`);
      rows.push(`| ${title.replace(/\|/g, "/")} | ${stated} | — | **from YouTube** | ${videoId} |`);
      continue;
    }
    const [dz, it] = await Promise.all([deezer(title).catch(() => null), itunes(title).catch(() => null)]);
    await sleep(350); // iTunes throttles around 20 requests a minute

    const same = dz && it && normalize(dz.artist) === normalize(it.artist);
    let verdict: string;
    if (same) {
      store[videoId] = dz!.artist;
      agreed++;
      verdict = `AGREED  ${dz!.artist}`;
    } else if (!dz && !it) {
      // Neither catalogue has it under any spelling, so it is native to YouTube.
      store[videoId] = null;
      youtubeOnly++;
      verdict = `YOUTUBE-ONLY`;
    } else {
      verdict = `REVIEW  deezer=${dz?.artist ?? "—"}  itunes=${it?.artist ?? "—"}`;
    }
    console.log(`  ${verdict.padEnd(46)} ${title.slice(0, 50)}`);
    rows.push(`| ${title.replace(/\|/g, "/")} | ${dz?.artist ?? "—"} | ${it?.artist ?? "—"} | ${same ? "**agreed**" : !dz && !it ? "YouTube-only" : "review"} | ${videoId} |`);
  }

  writeFileSync("artists.json", JSON.stringify(store, null, 2) + "\n");
  writeFileSync(
    "out/artists-review.md",
    [
      `# Artist lookup review`,
      ``,
      `Of ${todo.size} tracks: **${fromYouTube} stated by YouTube**, **${agreed} agreed by both catalogues**, **${youtubeOnly} exist only on YouTube**, **${todo.size - fromYouTube - agreed - youtubeOnly} still ambiguous**.`,
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
  console.log(
    `\n${fromYouTube} from YouTube, ${agreed} agreed by catalogues, ${youtubeOnly} YouTube-only, ` +
      `${todo.size - fromYouTube - agreed - youtubeOnly} left ambiguous. See out/artists-review.md.`,
  );
}

function selftest() {
  assert.ok(titlesMatch("Bodies", "Bodies"), "identical titles match");
  assert.ok(titlesMatch("Rosenrot", "Rosenrot (Album Version)"), "ignores bracketed suffixes");
  assert.ok(titlesMatch("É Só Você Lembrar", "E So Voce Lembrar"), "ignores accents");
  assert.ok(!titlesMatch("Bodies", "Bodies Fall"), "a longer different title is not a match");
  assert.ok(!titlesMatch("Metade", "Minha Metade Perfeita Do Amor"), "short title inside a long one is rejected");
  assert.ok(!titlesMatch("Anemia", "Academia"), "similar-looking but different titles do not match");
  assert.ok(PLACEHOLDERS.has("Release") && !PLACEHOLDERS.has("Gloria"), "a real artist is never looked up");

  // Fuzzy tolerance: wide enough for transliteration, narrow enough to reject near-misses.
  assert.ok(titlesMatch("Zetsubo Billy", "Zetsubou Billy"), "absorbs a transliteration variant");
  assert.ok(titlesMatch("Sonne", "Sonnne"), "absorbs a typo in a short title");
  assert.ok(!titlesMatch("Sonne", "Sonho"), "two edits in a short title is a different song");
  assert.ok(!titlesMatch("Amor", "Ator"), "very short titles stay strict");
  assert.ok(!titlesMatch("Gloria", "Gloria Estefan"), "an artist name appended is not the same title");

  assert.deepEqual(queryVariants("Celldweller feat. X - Shapeshifter"), ["Celldweller feat. X - Shapeshifter", "Shapeshifter"], "falls back to the text after the dash");
  assert.deepEqual(queryVariants("Bodies"), ["Bodies"], "a plain title is searched once");

  const cell = "Celldweller feat. Styles Of Beyond - Shapeshifter";
  assert.ok(!plausibleArtist(cell, "Shapeshifter", "Lorde"), "rejects a famous song that took over the shortened query");
  assert.ok(plausibleArtist(cell, "Shapeshifter", "Celldweller"), "accepts the artist actually named in the title");
  assert.ok(plausibleArtist("Bodies", "Bodies", "Drowning Pool"), "an unshortened query needs no corroboration");

  // Real description text, as returned for these video IDs.
  assert.equal(
    parseArtTrack("Provided to YouTube by Universal Music Group\n\nVai Pagar Caro Por Me Conhecer · Gloria\n\nGloria\n\n℗ 2009 Universal Music Ltda"),
    "Gloria",
    "reads the artist the label stated for this video",
  );
  assert.equal(
    parseArtTrack("Provided to YouTube by Lujo Network\n\nTrava na Pose (feat. Mc Rennan) · DJ Patrick Muniz · Dj Olliver · Mc Topre\n\nTrava na Pose"),
    "DJ Patrick Muniz, Dj Olliver, Mc Topre",
    "keeps every credited artist",
  );
  assert.equal(parseArtTrack("just a normal youtube description\nwith no credits"), null, "an ordinary upload has no credits to read");
  assert.equal(parseArtTrack(""), null, "an empty description resolves to nothing");

  assert.equal(parseDuration("PT3M22S"), 202, "minutes and seconds");
  assert.equal(parseDuration("PT1H2M3S"), 3723, "hours on a long upload");
  assert.equal(parseDuration("PT45S"), 45, "seconds only");
  assert.equal(parseDuration("PT0S"), null, "a zero length is no length at all");
  assert.equal(parseDuration("nonsense"), null, "unparseable input yields nothing");
  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) selftest();
else await main();

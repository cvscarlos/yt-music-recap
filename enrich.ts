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

  const todo = new Map<string, string>();
  for (const f of readdirSync("out").filter((x) => x.endsWith(".json"))) {
    for (const t of JSON.parse(readFileSync(`out/${f}`, "utf8"))) {
      if (PLACEHOLDERS.has(t.artist) && !(t.videoId in store)) todo.set(t.videoId, t.title);
    }
  }

  if (!todo.size) {
    console.log("Nothing to look up — every track already has an artist.");
    return;
  }
  console.log(`Looking up ${todo.size} tracks with a placeholder artist...\n`);

  const rows: string[] = [];
  let agreed = 0;
  let youtubeOnly = 0;
  for (const [videoId, title] of todo) {
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
      `Of ${todo.size} tracks: **${agreed} resolved** by agreement between both sources, **${youtubeOnly} exist only on YouTube**, **${todo.size - agreed - youtubeOnly} need a human**.`,
      ``,
      `YouTube-only tracks are mashups, meme edits and personal uploads that no music catalogue carries. They are recorded as resolved so they are not looked up again — they keep the channel name Takeout gave them.`,
      ``,
      `For the rest, pick a side and add it to artists.json as \`"videoId": "Artist"\`, then re-run recap.ts. Hand edits are never overwritten.`,
      ``,
      `| Track | Deezer | iTunes | Verdict | Video |`,
      `| --- | --- | --- | --- | --- |`,
      ...rows,
      ``,
    ].join("\n"),
  );
  console.log(`\n${agreed} resolved, ${youtubeOnly} YouTube-only, ${todo.size - agreed - youtubeOnly} need review. See out/artists-review.md.`);
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
  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) selftest();
else await main();

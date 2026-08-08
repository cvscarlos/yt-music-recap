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

// Guards against a search returning a different song that merely ranks well for the query.
export function titlesMatch(query: string, found: string): boolean {
  const [a, b] = [normalize(query), normalize(found)];
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length / long.length >= 0.6;
}

type Candidate = { artist: string; title: string } | null;

async function deezer(title: string): Promise<Candidate> {
  const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(title)}&limit=5`);
  if (!r.ok) return null;
  const hit = ((await r.json()) as any).data?.find((d: any) => titlesMatch(title, d.title));
  return hit ? { artist: hit.artist.name, title: hit.title } : null;
}

async function itunes(title: string): Promise<Candidate> {
  const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&entity=song&limit=5`);
  if (!r.ok) return null;
  const hit = ((await r.json()) as any).results?.find((x: any) => titlesMatch(title, x.trackName));
  return hit ? { artist: hit.artistName, title: hit.trackName } : null;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
  // Every recap shares one artist store, so a track resolved for 2025 is already fixed
  // for 2026. Existing entries are kept: a human may have corrected them by hand.
  const store: Record<string, string> = existsSync("artists.json")
    ? JSON.parse(readFileSync("artists.json", "utf8"))
    : {};

  const todo = new Map<string, string>();
  for (const f of readdirSync("out").filter((x) => x.endsWith(".json"))) {
    for (const t of JSON.parse(readFileSync(`out/${f}`, "utf8"))) {
      if (PLACEHOLDERS.has(t.artist) && !store[t.videoId]) todo.set(t.videoId, t.title);
    }
  }

  if (!todo.size) {
    console.log("Nothing to look up — every track already has an artist.");
    return;
  }
  console.log(`Looking up ${todo.size} tracks with a placeholder artist...\n`);

  const rows: string[] = [];
  let agreed = 0;
  for (const [videoId, title] of todo) {
    const [dz, it] = await Promise.all([deezer(title).catch(() => null), itunes(title).catch(() => null)]);
    await sleep(350); // iTunes throttles around 20 requests a minute

    const same = dz && it && normalize(dz.artist) === normalize(it.artist);
    if (same) {
      store[videoId] = dz!.artist;
      agreed++;
    }
    const verdict = same ? `AGREED  ${dz!.artist}` : dz || it ? `REVIEW  deezer=${dz?.artist ?? "—"}  itunes=${it?.artist ?? "—"}` : `NONE`;
    console.log(`  ${verdict.padEnd(46)} ${title.slice(0, 50)}`);
    rows.push(`| ${title.replace(/\|/g, "/")} | ${dz?.artist ?? "—"} | ${it?.artist ?? "—"} | ${same ? "**agreed**" : dz || it ? "review" : "not found"} | ${videoId} |`);
  }

  writeFileSync("artists.json", JSON.stringify(store, null, 2) + "\n");
  writeFileSync(
    "out/artists-review.md",
    [
      `# Artist lookup review`,
      ``,
      `${agreed} of ${todo.size} resolved by agreement between both sources and written to artists.json.`,
      `The rest need a human: add them to artists.json as \`"videoId": "Artist"\`, then re-run recap.ts.`,
      ``,
      `| Track | Deezer | iTunes | Verdict | Video |`,
      `| --- | --- | --- | --- | --- |`,
      ...rows,
      ``,
    ].join("\n"),
  );
  console.log(`\n${agreed}/${todo.size} agreed and written to artists.json. See out/artists-review.md for the rest.`);
}

function selftest() {
  assert.ok(titlesMatch("Bodies", "Bodies"), "identical titles match");
  assert.ok(titlesMatch("Rosenrot", "Rosenrot (Album Version)"), "ignores bracketed suffixes");
  assert.ok(titlesMatch("É Só Você Lembrar", "E So Voce Lembrar"), "ignores accents");
  assert.ok(!titlesMatch("Bodies", "Bodies Fall"), "a longer different title is not a match");
  assert.ok(!titlesMatch("Metade", "Minha Metade Perfeita Do Amor"), "short title inside a long one is rejected");
  assert.ok(!titlesMatch("Anemia", "Academia"), "similar-looking but different titles do not match");
  assert.ok(PLACEHOLDERS.has("Release") && !PLACEHOLDERS.has("Gloria"), "a real artist is never looked up");
  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) selftest();
else await main();

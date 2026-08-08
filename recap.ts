#!/usr/bin/env node
// Rebuild a YouTube Music Recap playlist from a Google Takeout watch-history.json.
//
//   node recap.ts <history.json[,more.json]> <period> [limit] [--min-seconds=N]
//   node recap.ts --selftest
//
// period: 2025 | h1-2025 | q3-2025 | summer-2025 | 2025-06-01..2025-08-31
//
// This runs twice for a full result, which is easy to mistake for a mistake. The first run
// ranks from the history alone and writes out/. enrich.ts then reads out/ and asks YouTube
// about the tracks that charted, leaving four files behind:
//
//   artists.json       a name for tracks YouTube labelled "Release" or left blank
//   durations.json     how long each track runs, which turns plays into listening time
//   recordings.json    which song a video holds, so versions of it count as one
//   availability.json  where each will play, so the playlist omits what would be hidden
//
// A second run applies all four. They are optional: without them the ranking is the same,
// only thinner. Nothing here reads them at import time, so rank() stays a pure function of
// its arguments and the self-test can drive it without touching the disk.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

type Activity = {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: { name?: string }[];
  time?: string;
};

type Track = {
  videoId: string;
  title: string;
  artist: string;
  plays: number;
  lastPlayedAt: string;
  minutes?: number; // time spent on this track, once enrich.ts has fetched its length
  versions?: number; // how many videos of this song were counted together, when above one
};

// A song while it is being counted: total plays, plus each video it was played from, so
// the most-played one can represent it afterwards.
type Song = {
  plays: number;
  lastPlayedAt: string;
  versions: Map<string, { plays: number; title: string; artist: string }>;
};

// Named periods as [first month, length in months]. Seasons are meteorological,
// northern hemisphere — winter starts in December of the named year and runs into the next.
const NAMED: Record<string, [number, number]> = {
  winter: [12, 3], spring: [3, 3], summer: [6, 3], autumn: [9, 3], fall: [9, 3],
  h1: [1, 6], h2: [7, 6],
  q1: [1, 3], q2: [4, 3], q3: [7, 3], q4: [10, 3],
};

function parsePeriod(period: string): { start: number; end: number; label: string } {
  const range = period.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    const end = new Date(`${range[2]}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1); // inclusive end date
    return { start: Date.parse(`${range[1]}T00:00:00Z`), end: +end, label: period };
  }

  const named = period.match(/^([a-z][a-z0-9]*)-(\d{4})$/i);
  if (named) {
    const span = NAMED[named[1].toLowerCase()];
    if (!span) throw new Error(`Unknown period "${named[1]}". Known: ${Object.keys(NAMED).join(", ")}`);
    const [month, length] = span;
    const start = Date.UTC(+named[2], month - 1, 1);
    const end = Date.UTC(+named[2], month - 1 + length, 1);
    return { start, end, label: period };
  }

  if (/^\d{4}$/.test(period)) {
    return { start: Date.UTC(+period, 0, 1), end: Date.UTC(+period + 1, 0, 1), label: period };
  }

  throw new Error(`Bad period "${period}". Use 2023, summer-2023, or 2023-06-01..2023-08-31`);
}

function videoIdOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get("v");
  } catch {
    return null;
  }
}

// A track abandoned inside a minute was skipped, not listened to, so it earns no play.
export const DEFAULT_MIN_SECONDS = 60;

export function rank(
  activities: Activity[],
  period: string,
  limit: number,
  minSeconds = DEFAULT_MIN_SECONDS,
  recordings: Record<string, string> = {},
  durations: Record<string, number> = {},
) {
  const { start, end, label } = parsePeriod(period);
  const seen = new Set<string>(); // same video at the same instant = duplicate export
  const byVideo = new Map<string, Song>();
  let listens = 0;
  let skipped = 0;

  // Takeout marks YouTube Music listens with this header. Music videos watched on
  // youtube.com proper are deliberately excluded — Recap only ever counted YTM.
  //
  // Duplicates are dropped here rather than in the loop below because two copies of one
  // record share a timestamp: left in, they would leave a zero-second gap and disguise
  // the genuine listen as a skip.
  const all = activities
    .filter((a) => a.header === "YouTube Music" && !Number.isNaN(Date.parse(a.time ?? "")))
    .map((a) => ({ at: Date.parse(a.time!), videoId: videoIdOf(a.titleUrl), a }))
    .filter((x) => {
      if (!x.videoId) return false; // deleted/private tracks lose their URL
      const key = `${x.videoId}@${x.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => x.at - y.at);
  if (!all.length) throw new Error("No YouTube Music activity in this file.");

  const dataStart = all[0].at;
  const dataEnd = all[all.length - 1].at;

  for (let i = 0; i < all.length; i++) {
    const { at, videoId, a } = all[i];
    if (!(at >= start && at < end)) continue;

    // Takeout records no playback duration, so the gap until the next listen is the only
    // available proxy for one: a track followed seconds later was skipped rather than
    // played. The final listen of a session has no successor, so it is always kept.
    if (minSeconds) {
      const gap = i < all.length - 1 ? (all[i + 1].at - at) / 1000 : Infinity;
      if (gap < minSeconds) {
        skipped++;
        continue;
      }
    }
    listens++;

    // Every version of a song answers to one key, so playing the studio take and the live
    // take both count towards that song. Videos with no known song stay on their own.
    const key = recordings[videoId!] ?? videoId!;

    let song = byVideo.get(key);
    if (!song) {
      song = { plays: 0, lastPlayedAt: "", versions: new Map() };
      byVideo.set(key, song);
    }
    song.plays++;
    if (a.time! > song.lastPlayedAt) song.lastPlayedAt = a.time!;

    const version = song.versions.get(videoId!) ?? {
      plays: 0,
      // "Watched " is English-only; other locales keep their own prefix in the title.
      title: (a.title ?? "").replace(/^Watched\s+/, ""),
      artist: (a.subtitles?.[0]?.name ?? "").replace(/\s+-\s+Topic$/, ""),
    };
    version.plays++;
    song.versions.set(videoId!, version);
  }

  // A song is represented by whichever of its versions was played most, so a playlist
  // gets the studio take you actually listen to rather than the live one you tried once.
  const tracks: Track[] = [...byVideo.values()]
    .map((song) => {
      const [videoId, top] = [...song.versions].sort((a, b) => b[1].plays - a[1].plays)[0];
      // Each version is timed by its own length. A live take can run twice as long as the
      // studio one, so charging every play to the representative's length misreports the
      // time spent. Versions of unknown length simply contribute nothing.
      const seconds = [...song.versions].reduce((total, [id, v]) => total + (durations[id] ?? 0) * v.plays, 0);
      return {
        videoId,
        title: top.title,
        artist: top.artist,
        plays: song.plays,
        lastPlayedAt: song.lastPlayedAt,
        ...(seconds ? { minutes: Math.round(seconds / 60) } : {}),
        ...(song.versions.size > 1 ? { versions: song.versions.size } : {}),
      };
    })
    .sort((a, b) => b.plays - a.plays || b.lastPlayedAt.localeCompare(a.lastPlayedAt))
    .slice(0, limit);

  // Exports get truncated (row caps, history auto-delete), so a period can silently rank
  // only the part of itself the file covers. Report where the export begins and ends but
  // not why — a short file is equally explained by truncation or by no listening yet.
  const covered = Math.min(end, dataEnd + 1) - Math.max(start, dataStart);
  const gaps: string[] = [];
  if (dataStart > start) gaps.push(`export starts ${new Date(dataStart).toISOString().slice(0, 10)}`);
  if (dataEnd < end - 1) gaps.push(`export ends ${new Date(dataEnd).toISOString().slice(0, 10)}`);
  const coverage = { pct: Math.max(0, Math.round((covered / (end - start)) * 100)), gaps };

  return { label, start, end, listens, skipped, minSeconds, uniqueTracks: byVideo.size, tracks, coverage };
}

function toMarkdown(r: ReturnType<typeof rank>): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // Merged songs say so, because a merge is a judgement that can be wrong: seeing a count
  // came from several videos is what lets an implausible one be spotted.
  const rows = r.tracks.map(
    (t, i) =>
      `| ${i + 1} | ${t.title}${t.versions ? ` *(${t.versions} versions)*` : ""} | ${t.artist} | ${t.plays} | ${t.minutes ?? "—"} | ${t.lastPlayedAt.slice(0, 10)} | https://music.youtube.com/watch?v=${t.videoId} |`,
  );
  const totalMinutes = r.tracks.reduce((sum, t) => sum + (t.minutes ?? 0), 0);
  return [
    `# ${r.label} Recap — top ${r.tracks.length}`,
    ``,
    `${r.listens} YouTube Music listens across ${r.uniqueTracks} tracks, ${day(r.start)} to ${day(r.end - 1)}.`,
    ...(r.minSeconds
      ? [``, `Excludes ${r.skipped} skips — tracks abandoned within ${r.minSeconds}s. Playback time is estimated from the gap to the next listen, as Takeout records no duration.`]
      : [``, `Counts every watch event, including skips.`]),
    ...(r.coverage.gaps.length
      ? [``, `> **Partial period — ${r.coverage.pct}% covered by this export** (${r.coverage.gaps.join(", ")}). Ranking is incomplete.`]
      : []),
    ``,
    ...(totalMinutes ? [``, `These ${r.tracks.length} tracks alone account for ${Math.round(totalMinutes / 60)} hours of listening.`] : []),
    ``,
    `| # | Track | Artist | Plays | Minutes | Last played | Link |`,
    `| --: | --- | --- | --: | --: | --- | --- |`,
    ...rows,
    ``,
  ].join("\n");
}

function selftest() {
  const listen = (time: string, v: string, title: string, artist: string): Activity => ({
    header: "YouTube Music",
    title: `Watched ${title}`,
    titleUrl: `https://music.youtube.com/watch?v=${v}`,
    subtitles: [{ name: `${artist} - Topic` }],
    time,
  });

  const data: Activity[] = [
    listen("2023-07-01T10:00:00Z", "aaa", "Summer Song", "Band"),
    listen("2023-07-02T10:00:00Z", "aaa", "Summer Song", "Band"),
    listen("2023-07-02T10:00:00Z", "aaa", "Summer Song", "Band"), // exact duplicate
    listen("2023-08-30T10:00:00Z", "bbb", "Other Song", "Band"),
    listen("2023-09-01T10:00:00Z", "ccc", "Autumn Song", "Band"), // outside summer
    { header: "YouTube", title: "Watched a podcast", titleUrl: "https://www.youtube.com/watch?v=ddd", time: "2023-07-03T10:00:00Z" },
  ];

  // Fixture listens sit days apart, so none look like skips — including the one whose
  // duplicate would otherwise sit at a zero-second distance from it.
  const r = rank(data, "summer-2023", 100);
  assert.equal(r.listens, 3, "dedupes identical entries, excludes non-YTM and out-of-range");
  assert.deepEqual(
    r.tracks.map((t) => [t.videoId, t.plays]),
    [["aaa", 2], ["bbb", 1]],
    "ranks by play count",
  );
  assert.equal(r.tracks[0].title, "Summer Song");
  assert.equal(r.tracks[0].artist, "Band", "strips the '- Topic' suffix");

  assert.equal(r.coverage.gaps.length, 1, "fixture has no June listens, so summer-2023 is flagged partial");

  assert.deepEqual(parsePeriod("2023").end, Date.UTC(2024, 0, 1));
  assert.deepEqual(parsePeriod("winter-2023").end, Date.UTC(2024, 2, 1), "winter spans the year boundary");
  assert.deepEqual(parsePeriod("2023-06-01..2023-08-31").end, Date.UTC(2023, 8, 1), "end date is inclusive");
  assert.deepEqual(parsePeriod("h1-2025"), { start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 6, 1), label: "h1-2025" });
  assert.deepEqual(parsePeriod("h2-2025"), { start: Date.UTC(2025, 6, 1), end: Date.UTC(2026, 0, 1), label: "h2-2025" });
  assert.deepEqual(parsePeriod("q4-2025"), { start: Date.UTC(2025, 9, 1), end: Date.UTC(2026, 0, 1), label: "q4-2025" });

  // A year the fixture only partly covers must flag itself rather than rank silently.
  const partial = rank(data, "2023", 100);
  assert.ok(partial.coverage.pct < 100 && partial.coverage.gaps.length === 2, "flags both leading and trailing gaps");

  // Skips: a track abandoned inside the threshold earns no play, one played through does.
  // The 45s gap must still count as a skip at the 60s default but not at 30s.
  const skips: Activity[] = [
    listen("2023-07-01T10:00:00Z", "quickskip", "Skipped After 8s", "Band"),
    listen("2023-07-01T10:00:08Z", "slowskip", "Skipped After 45s", "Band"),
    listen("2023-07-01T10:00:53Z", "kept", "Played Through", "Band"),
    listen("2023-07-01T10:04:00Z", "kept", "Played Through", "Band"),
  ];
  const q = rank(skips, "summer-2023", 100);
  assert.equal(q.skipped, 2, "60s default drops both the 8s and the 45s listen");
  assert.deepEqual(q.tracks.map((t) => t.videoId), ["kept"], "keeps the played-through track, and a session's final listen has no successor to measure");
  assert.equal(rank(skips, "summer-2023", 100, 30).skipped, 1, "a 30s threshold keeps the 45s listen");
  assert.equal(rank(skips, "summer-2023", 100, 0).listens, 4, "zero counts every event");

  // Every version of one song counts towards it, and the version played most represents
  // it — so a playlist gets the studio take rather than the live one heard once.
  const song = "papercut · linkin park"; // what songKey() yields for all three
  const versions: Activity[] = [
    listen("2023-07-01T10:00:00Z", "studio", "Papercut", "Linkin Park"),
    listen("2023-07-02T10:00:00Z", "studio", "Papercut", "Linkin Park"),
    listen("2023-07-03T10:00:00Z", "reissue", "Papercut", "Linkin Park"),
    listen("2023-07-04T10:00:00Z", "live", "Papercut (Live In Texas)", "Linkin Park"),
  ];
  const merged = rank(versions, "summer-2023", 100, 0, { studio: song, reissue: song, live: song });
  assert.equal(merged.tracks.length, 1, "studio, reissue and live take are all one song");
  assert.equal(merged.tracks[0].plays, 4, "every version's plays count towards the song");
  assert.equal(merged.tracks[0].versions, 3, "records how many videos were counted together");
  assert.equal(merged.tracks[0].videoId, "studio", "the most-played version represents the song");
  assert.equal(merged.tracks[0].title, "Papercut", "and so its title is the one shown");

  assert.equal(rank(versions, "summer-2023", 100, 0).tracks.length, 3, "without song data every video stands alone");

  // Each version is timed by its own length: three 3-minute plays plus one 10-minute live
  // play is 19 minutes. Charging all four to the representative's length would say 12.
  const timed = rank(versions, "summer-2023", 100, 0, { studio: song, reissue: song, live: song }, { studio: 180, reissue: 180, live: 600 });
  assert.equal(timed.tracks[0].minutes, 19, "a longer version contributes its own length");

  console.log("selftest ok");
}

const args = process.argv.slice(2);
const minSeconds = Number(args.find((a) => a.startsWith("--min-seconds="))?.split("=")[1] ?? DEFAULT_MIN_SECONDS);
const [file, period, limitArg] = args.filter((a) => !a.startsWith("--"));

// Only act when run directly, so importing rank() neither writes files nor exits.
if (import.meta.filename !== process.argv[1]) {
  // imported for its exports
} else if (args.includes("--selftest")) {
  selftest();
} else if (!file || !period || Number.isNaN(minSeconds)) {
  console.error(`usage: node recap.ts <watch-history.json> <period> [limit] [--min-seconds=N]  (default ${DEFAULT_MIN_SECONDS}, 0 counts every event)`);
  process.exit(1);
} else {
  // Exports are capped, so a longer history means several overlapping ones. Listing them
  // comma-separated merges them: duplicate records are already dropped by video ID and
  // timestamp, which is exactly what overlapping exports collide on.
  //
  // ponytail: parses them all into memory. Node handles a few hundred MB fine; switch to
  // a streaming parser only if a real export actually blows up.
  const activities: Activity[] = file
    .split(",")
    .flatMap((f) => JSON.parse(readFileSync(f.trim(), "utf8")) as Activity[]);
  const recordings: Record<string, string> = existsSync("recordings.json")
    ? JSON.parse(readFileSync("recordings.json", "utf8"))
    : {};
  const durations: Record<string, number> = existsSync("durations.json")
    ? JSON.parse(readFileSync("durations.json", "utf8"))
    : {};
  const result = rank(activities, period, Number(limitArg ?? 100), minSeconds, recordings, durations);
  const suffix = minSeconds === DEFAULT_MIN_SECONDS ? "" : `-min${minSeconds}s`;

  // Artists resolved by enrich.ts, or corrected by hand afterwards. Only tracks whose
  // Takeout channel was a placeholder ever appear here, so this cannot overwrite a real
  // artist name with a same-titled song by someone more famous.
  if (existsSync("artists.json")) {
    const artists: Record<string, string> = JSON.parse(readFileSync("artists.json", "utf8"));
    for (const t of result.tracks) t.artist = artists[t.videoId] ?? t.artist;
  }


  if (!result.listens) {
    console.error(`No YouTube Music listens found in ${period}.`);
    console.error(`File has ${activities.length} activities; ${activities.filter((a) => a.header === "YouTube Music").length} are YouTube Music.`);
    process.exit(1);
  }

  mkdirSync("out", { recursive: true });
  writeFileSync(`out/${result.label}${suffix}.md`, toMarkdown(result));
  writeFileSync(`out/${result.label}${suffix}.json`, JSON.stringify(result.tracks, null, 2));

  // Opening this URL while signed in builds a throwaway playlist you can then save, which
  // skips OAuth and the API quota entirely. Undocumented and capped at 50 videos, so it
  // is a convenience, not the export path — if it stops working, use the Data API.
  //
  // Written as HTML rather than a bare URL so it can simply be opened: a 600-character
  // link is not something anyone should have to copy out of a text file by hand.
  //
  // Tracks licensed away from here are left out and their places filled from further down
  // the ranking. Including them costs a slot each and YouTube silently hides them, so the
  // playlist arrives shorter than asked for with no explanation of why.
  const availability: Record<string, boolean> = existsSync("availability.json")
    ? (JSON.parse(readFileSync("availability.json", "utf8")).playable ?? {})
    : {};
  const unplayable = result.tracks.filter((t) => availability[t.videoId] === false).length;
  const shown = result.tracks.filter((t) => availability[t.videoId] !== false).slice(0, 50);
  const url = `https://www.youtube.com/watch_videos?video_ids=${shown.map((t) => t.videoId).join(",")}`;
  writeFileSync(
    `out/${result.label}${suffix}.playlist.html`,
    [
      `<meta charset="utf-8"><title>${result.label} playlist</title>`,
      `<body style="font:16px/1.6 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem">`,
      `<h1>${result.label} — top ${shown.length}</h1>`,
      `<p>Open the link below while signed in to YouTube. It builds a temporary playlist you can then save.</p>`,
      `<p><a href="${url}" style="font-size:1.2rem">Open these ${shown.length} tracks on YouTube &rarr;</a></p>`,
      result.tracks.length > 50
        ? `<p><em>Your recap has ${result.tracks.length} tracks, but this link carries at most 50 — the rest need the API export.</em></p>`
        : ``,
      unplayable
        ? `<p><em>${unplayable} track${unplayable === 1 ? "" : "s"} in this recap ${unplayable === 1 ? "is" : "are"} not licensed for your region and would be hidden by YouTube, so ${unplayable === 1 ? "it is" : "they are"} left out and the places filled from further down the ranking.</em></p>`
        : ``,
      `<ol>${shown.map((t) => `<li>${t.title} — ${t.artist}</li>`).join("")}</ol>`,
      `</body>`,
    ].join("\n"),
  );

  console.log(toMarkdown(result));
  console.error(`\nWrote out/${result.label}${suffix}.{md,json,playlist.html}`);
}

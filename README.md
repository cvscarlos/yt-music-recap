# yt-music-recap

Rebuild your YouTube Music Recap playlists for past years and seasons, from your own Google Takeout export.

YouTube only shows you a Recap for the current year, and the playlists disappear. If you have your listening history, the ranking can be reconstructed for any period — 2023, the first half of 2025, last summer — long after YouTube stopped showing it.

Two scripts, no dependencies, no build step. Everything runs locally and nothing is uploaded anywhere.

## Requirements

Node 22.18 or newer, which runs TypeScript directly. The repo pins Node 24 in `.nvmrc`.

## 1. Export your history

Google Takeout is the only source for your own listening history — no music service can reconstruct a past you did not scrobble at the time.

1. Open [Google Takeout](https://takeout.google.com), click **Deselect all**
2. Select **YouTube and YouTube Music**
3. Under **All YouTube data included**, keep only **history**
4. Under **Multiple formats**, set history to **JSON** — the default is HTML, which this cannot read
5. Export, wait for the email (hours to days), download and unzip

The file you want is `Takeout/YouTube and YouTube Music/history/watch-history.json`.

## 2. Generate a recap

```bash
node recap.ts watch-history.json 2025
node recap.ts watch-history.json h1-2025 50
node recap.ts watch-history.json summer-2023
```

Arguments are the history file, the period, and optionally how many tracks (default 100).

Exports are capped, so a history reaching further back means several of them. List them comma-separated and they merge — records duplicated between overlapping exports are dropped, so the same file listed twice changes nothing:

```bash
node recap.ts watch-history-2024.json,watch-history-2026.json 2025
```

| Period | Meaning |
| --- | --- |
| `2025` | calendar year |
| `h1-2025`, `h2-2025` | halves |
| `q1-2025` … `q4-2025` | quarters |
| `summer-2023` | meteorological season, northern hemisphere — also `winter`, `spring`, `autumn`/`fall` |
| `2023-06-01..2023-08-31` | any range, both dates included |

Each run writes three files to `out/`:

- `<period>.md` — the ranked list, readable
- `<period>.json` — the same data with video IDs, for building the playlist
- `<period>.playlist.html` — see [Turning it into a playlist](#turning-it-into-a-playlist)

## 3. Fill in missing artists (optional)

Some tracks reach the ranking with a placeholder instead of an artist — `Release`, or `Music Library Uploads` for your own uploaded files. `enrich.ts` resolves those.

```bash
export YOUTUBE_API_KEY=...
node enrich.ts
```

It asks YouTube first. Tracks generated for a label state their credits in the video description, keyed to the video ID, so the answer is exact and needs no checking. Anything without such credits falls back to searching Deezer and iTunes by title, and a name is only accepted when both independently return the same one.

Tracks that no catalogue carries — mashups, meme edits, personal uploads — are recorded as YouTube-only. That is a real answer, not a failure, and it stops them being looked up again.

The same request also returns each track's length, cached in `durations.json`, which is what lets a recap report listening time rather than only play counts.

Results go to `artists.json`, which `recap.ts` applies on the next run. Re-run the recap afterwards to see them.

Running without `YOUTUBE_API_KEY` works, but only the catalogue fallback is available, which resolves less and is less certain.

### Getting an API key

You need an **API key**, not an OAuth client — this only reads public data.

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable **YouTube Data API v3** in **APIs & Services → Library**
3. Create the key at `https://console.cloud.google.com/apis/credentials?project=<project-id>` → **Create credentials → API key**

There is no consent screen, no app verification and no OAuth flow. One request covers 50 videos and costs a single quota unit against a daily 10,000, so even a very large history costs a rounding error.

## Turning it into a playlist

Every run writes `out/<period>.playlist.html`. Open that file and follow the link while signed in, and YouTube builds a temporary playlist you can save. No API key, no OAuth, no quota.

It is capped at **50 videos** and relies on an undocumented URL, so treat it as a convenience. Creating a longer playlist properly needs OAuth and the YouTube Data API, where each added track costs 50 quota units — a 100-track playlist is about half a day's allowance.

## How the ranking works

Play count, highest first, ties broken by whichever was played more recently.

Deliberately nothing cleverer. Weighted scoring — recency, listening days, repeat intensity — was implemented and measured against real history, and rejected: unique listening days turned out to be identical to play count for 99.6% of tracks, and repeat listening was too rare to rank on. Sophistication belongs in cleaning the data before counting it, not in the scoring formula.

**A track abandoned within 60 seconds counts as a skip, not a play.** Takeout records no playback duration, so the gap until the next listen stands in for one. This is an estimate; `--min-seconds=0` counts every event, and any other value overrides the threshold.

## Known limits

**Exports get truncated.** Row caps and history auto-delete mean an export often covers less than you expect. Every recap reports how much of its period the export actually covers, so a year built from five months says so instead of quietly ranking a fraction of itself.

**Only YouTube Music listens count.** Music videos watched on youtube.com proper are excluded, matching what Recap counted.

**Every version of a song counts as that song.** The studio take, a reissue and a live take are one entry, represented by whichever version was played most. Version qualifiers live in brackets, so removing brackets tells a song apart from a version of it without depending on the word for "live" in any particular language — measured against real history, 97% of live markers are bracketed. The remainder, written after a dash or bare in the title, are missed.

**Merging only reaches tracks already in a ranking.** `enrich.ts` fetches credits for the tracks a recap lists, so versions are counted together only if one of them charted on its own. A song split across two videos that both sit below the cutoff stays split, and will not climb into the list.

**Merging needs `enrich.ts`.** Without it, or for uploads carrying no credits, every video stands alone.

**Titles keep any localised prefix.** Stripping `Watched ` only works on English exports. Tracks resolved through `enrich.ts` are unaffected, since their titles come from the credits rather than from the export.

## Privacy

Your listening history is sensitive. `watch-history.json`, `out/` and `artists.json` are all gitignored, nothing is sent anywhere except the metadata lookups you explicitly run, and those only ever send a track title or a video ID.

## Development

```bash
node recap.ts --selftest
node enrich.ts --selftest
```

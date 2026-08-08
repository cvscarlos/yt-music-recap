# yt-music-recap

**Get back the YouTube Music Recap playlists you lost.**

Every December, YouTube Music hands you a Recap. Then the year turns, and it's gone — the playlist, the rankings, the whole thing. There's no archive and no way to ask for last year's.

Your listening history still exists, though. This rebuilds any Recap from it: a year, a half, a season, or any range of dates you name. 2023. Summer 2022. The first half of 2025.

It runs on your machine, needs no account, and installs nothing.

## What it looks like

```
# 2025 Recap — top 100

16792 YouTube Music listens across 6397 tracks, 2025-01-01 to 2025-12-31.
Excludes 2554 skips — tracks abandoned within 60s.

These 100 tracks alone account for 117 hours of listening.

| # | Track                              | Artist      | Plays | Minutes |
| 1 | Vois Sur Ton Chemin *(2 versions)* | deprezz     |    51 |     160 |
| 2 | Só Eu Sei *(2 versions)*           | Gloria      |    46 |     163 |
| 3 | Out Of Control                     | Hoobastank  |    37 |     101 |
| 4 | RATATATA                           | BABYMETAL   |    31 |     112 |
```

Every track keeps its video ID, so the list turns straight into a real playlist.

## What makes the numbers right

**Skips don't count as plays.** A track you abandoned after eight seconds isn't a track you listened to. Anything dropped inside a minute is excluded, which on a real year removed 2,554 phantom plays.

**Every version of a song counts as that song.** The studio take, the live take and the reissue are one entry, credited to whichever version you actually played. One song split across two uploads had been sitting at 30 plays and 16 instead of 46 — enough to cost it the top spot for the year.

**Artists are the real ones.** YouTube labels plenty of tracks `Release` or leaves them blank. Those get resolved from the label's own credits for that exact video, not guessed from the title — so a small band never loses its songs to a famous act with the same name.

**Nothing is invented.** Ranking is play count, highest first. Weighted scoring was built, measured against real listening history, and thrown away: it changed nothing that mattered and made the result harder to trust.

**It doesn't assume your language.** Nothing keys off English or any other language — not the way skips are found, not the way versions are matched, not the way artists are read.

## Get your recap

**1. Export your history.** At [Google Takeout](https://takeout.google.com): *Deselect all* → **YouTube and YouTube Music** → under *All YouTube data included* keep only **history** → under *Multiple formats* set history to **JSON**. Export, then unzip what arrives. You want `watch-history.json`.

**2. Run it.**

```bash
node recap.ts watch-history.json 2025
```

**3. Open `out/`.** Your recap is there as a readable list, as data, and as a playlist link.

That's it. No install, no sign-up, no build step. Needs Node 22.18 or newer.

### Any period you like

```bash
node recap.ts watch-history.json 2023                      # a year
node recap.ts watch-history.json h1-2025                   # a half
node recap.ts watch-history.json q3-2024                   # a quarter
node recap.ts watch-history.json summer-2023               # a season
node recap.ts watch-history.json 2023-06-01..2023-08-31    # any range
```

Add a number to change the length: `node recap.ts watch-history.json 2025 50`.

Google caps each export, so a history reaching further back means several of them. List them together and they merge, duplicates and all:

```bash
node recap.ts watch-history-2024.json,watch-history-2026.json 2025
```

## Turn it into a playlist

Open `out/2025.playlist.html` and follow the link while signed in to YouTube. It builds the playlist for you, ready to save.

No API key, no OAuth, no Google Cloud project, no quota. Fifty tracks.

## Better artists, and listening time

Optional, and worth it. With a free YouTube API key, every track gets the artist its label credited and the recap can tell you hours listened rather than only play counts.

```bash
cp .env.sample .env      # then paste your key in
node enrich.ts
node recap.ts watch-history.json 2025
```

Getting the key takes about a minute — create a project at [console.cloud.google.com](https://console.cloud.google.com), enable **YouTube Data API v3**, then make an **API key** at `https://console.cloud.google.com/apis/credentials?project=<project-id>`. It's a plain API key, so there's no consent screen and no app review. A whole history costs a rounding error against the free daily allowance.

## Browse your recaps

They're plain files, so anything works. To flip through them in a browser:

```bash
npx serve ./out/ -l 4900
```

## Your history stays yours

It never leaves your machine. There's no account, no server, no telemetry — the only thing that goes out is a track title or video ID when you ask for artists, and only then.

Your history, your recaps and everything derived from them are kept out of git already, so you can fork this and publish it without publishing yourself.

## Good to know

**Exports are often shorter than you expect.** Row caps and history auto-delete both bite, and one real export turned out to hold exactly two years. Every recap tells you how much of its period it actually covers, so a year built from five months says so rather than quietly ranking a fraction of itself.

**Only YouTube Music counts.** Music videos watched on youtube.com proper are left out, which is what Recap did too.

**Some tracks exist only on YouTube.** Mashups, meme edits and your own uploads aren't in any music catalogue. They're kept, with whatever name YouTube gave them.

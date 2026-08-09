#!/usr/bin/env node
// Create a real, permanent YouTube playlist from a recap.
//
//   node export.ts <period> [--title "..."] [--public]
//
// The list a watch_videos link builds is temporary and belongs to nobody, so YouTube offers
// no way to keep it. Creating one you own is the only way, and that means acting as you,
// which means OAuth — an API key authorises reading public data and nothing more.
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, from an OAuth client of type
// "Desktop app". The refresh token it earns is written back to .env, so authorising happens
// once rather than daily, and every secret this project holds lives in one file that is
// already ignored by git and understood by anyone reading the repo to be off limits.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

// .env is yours; oauth.env is this program's, holding only the token it earned.
const TOKEN_FILE = "oauth.env";
for (const file of [".env", TOKEN_FILE]) {
  try {
    process.loadEnvFile(file);
  } catch {}
}

const SCOPE = "https://www.googleapis.com/auth/youtube";
const base64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Proof Key for Code Exchange. A desktop client's secret ships to every user and so is not
// secret; this is what actually ties the code Google returns to the process that asked.
export function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

// Waits on a loopback port for Google to send the browser back with a code.
function awaitCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const failed = url.searchParams.get("error");
      const answer = code ? "Authorised. Close this tab and return to the terminal." : `Authorisation failed: ${failed}`;
      res.writeHead(code ? 200 : 400, { "content-type": "text/plain; charset=utf-8" }).end(answer);
      server.close();
      if (!code) return reject(new Error(failed ?? "no code returned"));
      if (url.searchParams.get("state") !== expectedState) return reject(new Error("state did not match the request"));
      resolve(code);
    });
    server.listen(port, "127.0.0.1");
    setTimeout(() => (server.close(), reject(new Error("timed out waiting for authorisation"))), 300_000);
  });
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await r.json()) as any;
  if (!r.ok) throw new Error(`token request failed: ${json.error_description ?? json.error ?? r.status}`);
  return json;
}

// A refresh token, once granted, is reusable — so the browser dance happens once.
async function accessToken(clientId: string, clientSecret: string): Promise<string> {
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    try {
      const refreshed = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        client_id: clientId,
        client_secret: clientSecret,
      });
      return refreshed.access_token;
    } catch {
      // Google expires refresh tokens for apps still in testing, so fall through and re-ask.
      console.log("  Stored authorisation is no longer valid. Asking again.");
    }
  }

  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(16));
  const port = 8000 + Math.floor(Math.random() * 1000);
  const redirect = `http://127.0.0.1:${port}`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();

  console.log("Opening your browser to authorise this app.");
  console.log(`If it does not open, visit:\n  ${auth}\n`);
  const waiting = awaitCode(port, state);
  openBrowser(auth.toString());

  const granted = await tokenRequest({
    grant_type: "authorization_code",
    code: await waiting,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  // Its own file, not the one you edit: nothing this program writes should be able to
  // disturb a key you typed in by hand.
  writeFileSync(TOKEN_FILE, `# Written by export.ts. Delete this to authorise again.\nGOOGLE_REFRESH_TOKEN=${granted.refresh_token}\n`);
  return granted.access_token;
}

async function youtube(path: string, token: string, body: unknown, params: string) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${params}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json()) as any;
  if (!r.ok) throw new Error(json.error?.message ?? `${path} failed with ${r.status}`);
  return json;
}

async function main() {
  const args = process.argv.slice(2);
  const [period] = args.filter((a) => !a.startsWith("--"));
  const title = args.find((a) => a.startsWith("--title="))?.slice(8) ?? `${period} Recap`;
  const privacy = args.includes("--public") ? "public" : "private";

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!period || !clientId || !clientSecret) {
    console.error("usage: node export.ts <period> [--title=\"...\"] [--public] [--playable-only]");
    console.error("needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env — see .env.sample");
    process.exit(1);
  }

  const file = `out/${period}.json`;
  if (!existsSync(file)) {
    console.error(`No recap at ${file}. Run recap.ts for ${period} first.`);
    process.exit(1);
  }
  const tracks: { videoId: string; title: string; artist: string }[] = JSON.parse(readFileSync(file, "utf8"));

  // Tracks not licensed here are added anyway. They are part of the year, licensing changes
  // and a hidden entry becomes visible when it does, and dropping them would silently make
  // a "top 100" shorter than it claims. YouTube hides them meanwhile; --playable-only
  // leaves them out for a playlist meant to be listened to straight through.
  const availability: Record<string, boolean> = existsSync("availability.json")
    ? (JSON.parse(readFileSync("availability.json", "utf8")).playable ?? {})
    : {};
  const blocked = tracks.filter((t) => availability[t.videoId] === false).length;
  const playable = args.includes("--playable-only") ? tracks.filter((t) => availability[t.videoId] !== false) : tracks;
  const hidden = args.includes("--playable-only") ? 0 : blocked;

  // Creating costs 50 units and each track another 50, against 10,000 a day.
  const cost = 50 + playable.length * 50;
  console.log(
    `Creating "${title}" (${privacy}) with ${playable.length} tracks` +
      (hidden ? `, ${hidden} of which YouTube will hide until they are licensed in your region` : "") +
      (args.includes("--playable-only") && blocked ? `, leaving out ${blocked} unplayable` : "") +
      ".",
  );
  console.log(`Costs about ${cost.toLocaleString()} of the 10,000 daily quota units.\n`);

  const token = await accessToken(clientId, clientSecret);
  const playlist = await youtube(
    "playlists",
    token,
    { snippet: { title, description: `Reconstructed from Google Takeout listening history.` }, status: { privacyStatus: privacy } },
    "part=snippet,status",
  );

  let added = 0;
  for (const track of playable) {
    try {
      await youtube(
        "playlistItems",
        token,
        { snippet: { playlistId: playlist.id, resourceId: { kind: "youtube#video", videoId: track.videoId } } },
        "part=snippet",
      );
      added++;
      process.stdout.write(`\r  added ${added}/${playable.length}`);
    } catch (e) {
      // One unavailable video should not abandon the other forty-nine.
      console.error(`\n  skipped ${track.title} — ${(e as Error).message}`);
    }
  }
  console.log(`\n\nDone: https://music.youtube.com/playlist?list=${playlist.id}`);
}

function selftest() {
  const a = pkce();
  const b = pkce();
  assert.notEqual(a.verifier, b.verifier, "every attempt gets its own verifier");
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/, "verifier is URL-safe and long enough to be unguessable");
  assert.match(a.challenge, /^[A-Za-z0-9_-]+$/, "challenge carries nothing needing encoding");
  assert.notEqual(a.challenge, a.verifier, "the challenge is a hash, not the secret itself");
  assert.equal(
    a.challenge,
    base64url(createHash("sha256").update(a.verifier).digest()),
    "and is the one Google will recompute",
  );
  console.log("selftest ok");
}

if (import.meta.filename !== process.argv[1]) {
  // imported for its exports
} else if (process.argv.includes("--selftest")) {
  selftest();
} else {
  await main();
}

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTrackSearch, parseChatCommand, parseMusicLink } from "../lib/chat-command.mjs";

test("recognizes Russian and English track commands", () => {
  assert.deepEqual(parseChatCommand("!трек Daft Punk - One More Time"), {
    command: "track",
    argument: "Daft Punk - One More Time",
  });
  assert.deepEqual(parseChatCommand("!TRACK  discovery "), {
    command: "track",
    argument: "discovery",
  });
});

test("recognizes skip commands without accepting trailing arguments", () => {
  assert.deepEqual(parseChatCommand("!скип"), { command: "skip_start", argument: "" });
  assert.deepEqual(parseChatCommand("!skip now"), { command: "skip_start", argument: "" });
});

test("ignores ordinary chat and unknown commands", () => {
  assert.deepEqual(parseChatCommand("скип"), { command: "skip_vote", argument: "" });
  assert.deepEqual(parseChatCommand("SKIP"), { command: "skip_vote", argument: "" });
  assert.equal(parseChatCommand("привет"), null);
  assert.equal(parseChatCommand("!song something"), null);
  assert.equal(parseChatCommand(""), null);
  assert.equal(parseChatCommand(null), null);
});

test("normalizes and bounds search input", () => {
  assert.equal(normalizeTrackSearch("  Artist\n -  Title  "), "Artist - Title");
  assert.equal(normalizeTrackSearch("a".repeat(200)).length, 100);
  assert.equal(normalizeTrackSearch("a\u0000b"), "a b");
});


test("recognizes YouTube and YouTube Music video links and strips tracking parameters", () => {
  assert.deepEqual(
    parseMusicLink("https://www.youtube.com/watch?v=vqNmzUZd9DY&list=RDMMvqNmzUZd9DY&start_radio=1"),
    { provider: "youtube", providerTrackId: "vqNmzUZd9DY", canonicalUrl: "https://www.youtube.com/watch?v=vqNmzUZd9DY" },
  );
  assert.deepEqual(
    parseMusicLink("https://music.youtube.com/watch?v=evJ6gX1lp2o&si=ntIFkFSSSIPZX-RQ&drli=1"),
    { provider: "youtube", providerTrackId: "evJ6gX1lp2o", canonicalUrl: "https://www.youtube.com/watch?v=evJ6gX1lp2o" },
  );
});

test("recognizes Spotify track links and rejects unsupported or unsafe URLs", () => {
  assert.deepEqual(
    parseMusicLink("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc"),
    { provider: "spotify", providerTrackId: "4uLU6hMCjMI75M1A2tKUQC", canonicalUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" },
  );
  assert.equal(parseMusicLink("http://youtube.com/watch?v=vqNmzUZd9DY"), null);
  assert.equal(parseMusicLink("https://youtube.com.evil.example/watch?v=vqNmzUZd9DY"), null);
  assert.equal(parseMusicLink("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), null);
  assert.equal(parseMusicLink("javascript:alert(1)"), null);
});

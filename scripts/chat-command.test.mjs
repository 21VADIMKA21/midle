import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTrackSearch, parseChatCommand } from "../lib/chat-command.mjs";

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
  assert.deepEqual(parseChatCommand("!скип"), { command: "skip", argument: "" });
  assert.deepEqual(parseChatCommand("!skip now"), { command: "skip", argument: "" });
});

test("ignores ordinary chat and unknown commands", () => {
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

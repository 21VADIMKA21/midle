const TRACK_COMMANDS = new Set(["!трек", "!track"]);
const SKIP_START_COMMANDS = new Set(["!скип", "!skip"]);
const SKIP_VOTE_MESSAGES = new Set(["скип", "skip"]);

export function parseChatCommand(message) {
  if (typeof message !== "string") return null;

  const trimmed = message.trim();
  if (!trimmed) return null;

  const plain = trimmed.toLocaleLowerCase("ru-RU");
  if (SKIP_VOTE_MESSAGES.has(plain)) return { command: "skip_vote", argument: "" };
  if (!trimmed.startsWith("!")) return null;

  const separator = trimmed.search(/\s/);
  const command = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLocaleLowerCase("ru-RU");
  const argument = separator === -1 ? "" : trimmed.slice(separator).trim();

  if (TRACK_COMMANDS.has(command)) {
    return { command: "track", argument: argument.slice(0, 2048) };
  }

  if (SKIP_START_COMMANDS.has(command)) {
    return { command: "skip_start", argument: "" };
  }

  return null;
}

export function normalizeTrackSearch(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}


export function parseMusicLink(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    (host === "youtube.com" || host === "music.youtube.com") &&
    url.pathname === "/watch"
  ) {
    const id = url.searchParams.get("v");
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { provider: "youtube", providerTrackId: id, canonicalUrl: "https://www.youtube.com/watch?v=" + id };
  }
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { provider: "youtube", providerTrackId: id, canonicalUrl: "https://www.youtube.com/watch?v=" + id };
  }
  if (host === "open.spotify.com") {
    const match = url.pathname.match(/^\/track\/([A-Za-z0-9]{22})\/?$/);
    if (!match) return null;
    return { provider: "spotify", providerTrackId: match[1], canonicalUrl: "https://open.spotify.com/track/" + match[1] };
  }
  return null;
}

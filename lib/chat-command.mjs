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
    return { command: "track", argument: argument.slice(0, 100) };
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

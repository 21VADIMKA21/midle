const TRACK_COMMANDS = new Set(["!трек", "!track"]);
const SKIP_COMMANDS = new Set(["!скип", "!skip"]);

export function parseChatCommand(message) {
  if (typeof message !== "string") return null;

  const trimmed = message.trim();
  if (!trimmed || !trimmed.startsWith("!")) return null;

  const separator = trimmed.search(/\s/);
  const command = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLocaleLowerCase("ru-RU");
  const argument = separator === -1 ? "" : trimmed.slice(separator).trim();

  if (TRACK_COMMANDS.has(command)) {
    return { command: "track", argument: argument.slice(0, 100) };
  }

  if (SKIP_COMMANDS.has(command)) {
    return { command: "skip", argument: "" };
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

import type { FusionFileHandle } from "../types/player-browser";
import { saveCurrentRequestId } from "./player-browser-storage";

type PlayerStatus = "online" | "playing" | "paused" | "offline" | "error";
type MutableRef<T> = { current: T };

export type PlayerCommand = {
  id: string | number;
  command: string;
  payload: Record<string, unknown>;
};

export type PlayerEngineContext = {
  audio: MutableRef<HTMLAudioElement | null>;
  files: MutableRef<Map<string, FusionFileHandle>>;
  currentRequestId: MutableRef<string | null>;
  objectUrl: MutableRef<string | null>;
  status: MutableRef<PlayerStatus>;
  volume: MutableRef<number>;
  setCurrentRequestId: (value: string | null) => void;
  setCurrentTrack: (value: { title: string; artist: string } | null) => void;
  setStatus: (value: PlayerStatus) => void;
  setMessage: (value: string) => void;
};

async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sendTrackEvent(
  token: string,
  eventType: "started" | "finished",
  requestId: string,
): Promise<void> {
  const eventId = crypto.randomUUID();
  let lastError = "player_event_failed";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/player/track-event", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ eventId, requestId, eventType }),
      });
      if (response.ok) return;
      const data = await response.json().catch(() => null);
      lastError = typeof data?.error === "string" ? data.error : "player_event_failed";
    } catch {
      lastError = "network_error";
    }

    if (attempt < 2) {
      await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  throw new Error(lastError);
}

export async function playLocalRequest(
  token: string,
  requestId: string,
  context: PlayerEngineContext,
): Promise<void> {
  const audio = context.audio.current;
  if (!audio) throw new Error("audio_element_unavailable");

  if (context.currentRequestId.current === requestId && !audio.paused) {
    return;
  }

  const response = await fetch("/api/player/requests/" + requestId, {
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 404 && context.currentRequestId.current === requestId) {
      context.currentRequestId.current = null;
      context.setCurrentRequestId(null);
      context.setCurrentTrack(null);
      context.status.current = "online";
      context.setStatus("online");
      await saveCurrentRequestId(null);
    }
    throw new Error("request_unavailable");
  }

  const data = await response.json();
  const providerTrackId = data?.track?.providerTrackId;
  const fileHandle = typeof providerTrackId === "string"
    ? context.files.current.get(providerTrackId)
    : undefined;
  if (!fileHandle) throw new Error("local_file_missing");

  if (!/^[a-f0-9]{64}$/i.test(providerTrackId)) {
    throw new Error("invalid_local_track_hash");
  }

  const file = await fileHandle.getFile();
  if (file.size > 200_000_000) {
    throw new Error("local_file_too_large");
  }
  const actualHash = await hashFile(file);
  if (actualHash !== providerTrackId.toLowerCase()) {
    throw new Error("local_file_changed_sync_library");
  }

  const url = URL.createObjectURL(file);

  try {
    audio.pause();
    if (context.objectUrl.current) URL.revokeObjectURL(context.objectUrl.current);
    context.objectUrl.current = url;
    context.currentRequestId.current = requestId;
    context.status.current = "online";
    context.setCurrentRequestId(requestId);
    context.setCurrentTrack({
      title: data.track.title || file.name,
      artist: data.track.artist || "Unknown artist",
    });
    await saveCurrentRequestId(requestId);

    audio.src = url;
    audio.volume = context.volume.current;
    audio.currentTime = 0;
    await audio.play();
    await sendTrackEvent(token, "started", requestId);

    context.status.current = "playing";
    context.setStatus("playing");
    context.setMessage("Сейчас играет: " + (data.track.title || file.name));
  } catch (error) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (context.objectUrl.current) URL.revokeObjectURL(context.objectUrl.current);
    context.objectUrl.current = null;
    context.currentRequestId.current = null;
    context.status.current = "error";
    context.setCurrentRequestId(null);
    context.setCurrentTrack(null);
    context.setStatus("error");
    await saveCurrentRequestId(null);
    throw error;
  }
}

export async function finishCurrentTrack(
  token: string,
  context: PlayerEngineContext,
): Promise<void> {
  const requestId = context.currentRequestId.current;
  if (!requestId) return;

  await sendTrackEvent(token, "finished", requestId);

  const audio = context.audio.current;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (context.objectUrl.current) URL.revokeObjectURL(context.objectUrl.current);
  context.objectUrl.current = null;
  context.currentRequestId.current = null;
  context.status.current = "online";
  context.setCurrentRequestId(null);
  context.setCurrentTrack(null);
  context.setStatus("online");
  await saveCurrentRequestId(null);
  context.setMessage("Трек завершён. Следующий запрос запускается автоматически.");
}

export async function executePlayerCommand(
  token: string,
  command: PlayerCommand,
  context: PlayerEngineContext,
  resyncLibrary: () => Promise<boolean>,
): Promise<void> {
  let success = true;
  let errorCode: string | null = null;

  try {
    switch (command.command) {
      case "play": {
        const requestId = command.payload?.requestId;
        if (typeof requestId !== "string") throw new Error("invalid_request_id");
        await playLocalRequest(token, requestId, context);
        break;
      }
      case "pause": {
        context.audio.current?.pause();
        context.status.current = "paused";
        context.setStatus("paused");
        context.setMessage("Воспроизведение приостановлено.");
        break;
      }
      case "resume": {
        const audio = context.audio.current;
        if (!audio?.src) throw new Error("nothing_to_resume");
        await audio.play();
        context.status.current = "playing";
        context.setStatus("playing");
        context.setMessage("Воспроизведение продолжено.");
        break;
      }
      case "skip": {
        const targetRequestId = command.payload?.requestId;
        if (typeof targetRequestId === "string" && context.currentRequestId.current !== targetRequestId) {
          break;
        }
        await finishCurrentTrack(token, context);
        break;
      }
      case "set_volume": {
        const volume = command.payload?.volume;
        if (typeof volume !== "number" || !Number.isFinite(volume)) throw new Error("invalid_volume");
        context.volume.current = Math.max(0, Math.min(1, volume));
        if (context.audio.current) context.audio.current.volume = context.volume.current;
        break;
      }
      case "resync_library": {
        const synced = await resyncLibrary();
        if (!synced) throw new Error("library_sync_failed");
        break;
      }
      default:
        throw new Error("unknown_player_command");
    }
  } catch (error) {
    success = false;
    errorCode = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : "player_command_failed";
    const friendlyErrors: Record<string, string> = {
      local_file_missing: "Файл трека не найден. Синхронизируй локальную библиотеку заново.",
      local_file_changed_sync_library: "Файл изменился после синхронизации. Обнови библиотеку и подтверди права ещё раз.",
      local_file_too_large: "Файл слишком большой для локального проигрывателя.",
      invalid_local_track_hash: "У трека повреждён идентификатор. Синхронизируй библиотеку заново.",
      NotFoundError: "Файл удалён или перемещён. Синхронизируй библиотеку заново.",
      NotAllowedError: "Браузер потерял доступ к музыкальной папке. Разреши доступ и синхронизируй библиотеку заново.",
    };
    context.setMessage(friendlyErrors[errorCode] || "Ошибка команды проигрывателя: " + errorCode);
  }

  try {
    const response = await fetch("/api/player/commands/ack", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commandId: String(command.id), success, errorCode }),
    });
    if (!response.ok) {
      context.setMessage("Не удалось подтвердить команду серверу. Она будет отправлена повторно.");
    }
  } catch {
    context.setMessage("Нет связи для подтверждения команды. Повторим позже.");
  }
}

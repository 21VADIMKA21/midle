"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  executePlayerCommand,
  finishCurrentTrack,
  playLocalRequest,
  type PlayerEngineContext,
} from "../../lib/player-browser-engine";
import {
  loadCurrentRequestId,
  loadLibraryDirectory,
  loadPlayerToken,
  saveLibraryDirectory,
  savePlayerToken,
} from "../../lib/player-browser-storage";
import type { FusionDirectoryHandle, FusionFileHandle } from "../../types/player-browser";

type LocalTrack = {
  hash: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  album: string | null;
  format: string;
  fileSize: number;
};

type PlayerStatus = "online" | "playing" | "paused" | "offline" | "error";

const SUPPORTED_FORMATS = new Set(["mp3", "m4a", "wav", "ogg", "flac"]);

function parseFileName(fileName: string): { title: string; artist: string } {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim();
  const separator = baseName.indexOf(" - ");
  if (separator > 0) {
    return {
      artist: baseName.slice(0, separator).trim() || "Unknown artist",
      title: baseName.slice(separator + 3).trim() || baseName,
    };
  }
  return { title: baseName || fileName, artist: "Unknown artist" };
}

async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function scanDirectory(
  directory: FusionDirectoryHandle,
  result: LocalTrack[],
  fileMap: Map<string, FusionFileHandle>,
): Promise<void> {
  for await (const entry of directory.values()) {
    if (result.length >= 2000) return;

    if (entry.kind === "directory") {
      await scanDirectory(entry, result, fileMap);
      continue;
    }

    const fileHandle = entry as FusionFileHandle;
    const extension = fileHandle.name.split(".").pop()?.toLowerCase() || "";
    if (!SUPPORTED_FORMATS.has(extension)) continue;

    const file = await fileHandle.getFile();
    if (file.size > 200_000_000) continue;
    const name = parseFileName(file.name);
    const hash = await hashFile(file);
    result.push({
      hash,
      title: name.title.slice(0, 200),
      artist: name.artist.slice(0, 200),
      durationSeconds: null,
      album: null,
      format: extension,
      fileSize: file.size,
    });
    fileMap.set(hash, fileHandle);
  }
}

export default function PlayerPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [directory, setDirectory] = useState<FusionDirectoryHandle | null>(null);
  const [trackCount, setTrackCount] = useState(0);
  const [libraryReady, setLibraryReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Подготавливаем Fusion Player…");
  const [outputDevice, setOutputDevice] = useState("");
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  const [currentTrack, setCurrentTrack] = useState<{ title: string; artist: string } | null>(null);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>("online");

  const audioRef = useRef<HTMLAudioElement>(null);
  const fileMapRef = useRef<Map<string, FusionFileHandle>>(new Map());
  const currentRequestRef = useRef<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const statusRef = useRef<PlayerStatus>("online");
  const volumeRef = useRef(0.8);
  const syncingRef = useRef(false);
  const syncLibraryRef = useRef<() => Promise<boolean>>(async () => false);

  const engineContext = useCallback((): PlayerEngineContext => ({
    audio: audioRef,
    files: fileMapRef,
    currentRequestId: currentRequestRef,
    objectUrl: objectUrlRef,
    status: statusRef,
    volume: volumeRef,
    setCurrentRequestId: (value) => {
      currentRequestRef.current = value;
      setCurrentRequestId(value);
    },
    setCurrentTrack,
    setStatus: (value) => {
      statusRef.current = value;
      setPlayerStatus(value);
    },
    setMessage,
  }), []);

  const sendHeartbeat = useCallback(async (token: string) => {
    const response = await fetch("/api/player/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: statusRef.current,
        currentRequestId: currentRequestRef.current,
        clientVersion: "pwa-0.2.0",
      }),
    });
    return response.ok;
  }, []);

  useEffect(() => {
    let cancelled = false;

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    async function restore() {
      try {
        const savedToken = await loadPlayerToken();
        const savedRequestId = await loadCurrentRequestId();
        if (cancelled) return;

        if (savedRequestId) {
          currentRequestRef.current = savedRequestId;
          setCurrentRequestId(savedRequestId);
          statusRef.current = "playing";
          setPlayerStatus("playing");
        }

        if (savedToken) {
          setDeviceToken(savedToken);
          setMessage("Сохранённый ключ найден. Проверяем подключение…");
          const libraryResponse = await fetch("/api/player/library", {
            headers: { Authorization: "Bearer " + savedToken },
            cache: "no-store",
          });
          if (libraryResponse.ok) {
            const libraryData = await libraryResponse.json();
            setTrackCount(libraryData.trackCount || 0);
          }
        } else {
          setMessage("Подключи Fusion Player одноразовым ключом из панели владельца.");
        }

        const savedDirectory = await loadLibraryDirectory();
        if (!cancelled && savedDirectory) {
          setDirectory(savedDirectory);
          setMessage(savedToken ? "Папка найдена. Синхронизируй её, чтобы восстановить воспроизведение." : "Локальная папка найдена. Подключи проигрыватель.");
        }
      } catch {
        if (!cancelled) setMessage("Не удалось восстановить локальные настройки. Можно подключить проигрыватель заново.");
      }
    }

    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!deviceToken) return;
    let stopped = false;

    const heartbeat = async () => {
      try {
        const ok = await sendHeartbeat(deviceToken);
        if (stopped) return;
        setConnected(ok);
        if (!ok) setMessage("Ключ больше не действует. Подключи проигрыватель заново.");
      } catch {
        if (!stopped) {
          setConnected(false);
          setMessage("Нет соединения с сервером. Повторяем подключение…");
        }
      }
    };

    void heartbeat();
    const timer = window.setInterval(() => { void heartbeat(); }, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [deviceToken, sendHeartbeat]);

  async function connectPlayer() {
    const token = tokenInput.trim();
    if (token.length < 32) {
      setMessage("Вставь полный ключ подключения из панели владельца.");
      return;
    }

    setBusy(true);
    try {
      statusRef.current = "online";
      const ok = await sendHeartbeat(token);
      if (!ok) {
        setMessage("Сервер не принял ключ. Проверь, что он не был отозван.");
        return;
      }
      await savePlayerToken(token);
      const libraryResponse = await fetch("/api/player/library", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      if (libraryResponse.ok) {
        const libraryData = await libraryResponse.json();
        setTrackCount(libraryData.trackCount || 0);
      }
      setDeviceToken(token);
      setConnected(true);
      setTokenInput("");
      setMessage("Fusion Player подключён к серверу.");
    } catch {
      setMessage("Не удалось подключиться. Проверь адрес сайта и ключ.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseLibrary() {
    if (!window.showDirectoryPicker) {
      setMessage("Нужен актуальный Chrome или Edge для доступа к локальной папке.");
      return;
    }

    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await saveLibraryDirectory(handle);
      setDirectory(handle);
      setLibraryReady(false);
      fileMapRef.current.clear();
      setMessage("Выбрана папка: " + handle.name + ". Теперь синхронизируй библиотеку.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Не удалось открыть папку. Разреши доступ и попробуй ещё раз.");
    }
  }

  const syncLibrary = useCallback(async (): Promise<boolean> => {
    if (syncingRef.current) return false;
    if (!deviceToken) {
      setMessage("Сначала подключи Fusion Player.");
      return false;
    }
    if (!directory) {
      setMessage("Сначала выбери папку с аудиофайлами.");
      return false;
    }

    syncingRef.current = true;
    setBusy(true);
    setMessage("Сканируем локальную библиотеку…");
    try {
      let permission = await directory.queryPermission({ mode: "read" });
      if (permission !== "granted") {
        permission = await directory.requestPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        setMessage("Браузеру не разрешено читать эту папку.");
        return false;
      }

      const tracks: LocalTrack[] = [];
      const localFiles = new Map<string, FusionFileHandle>();
      await scanDirectory(directory, tracks, localFiles);
      if (!tracks.length) {
        setMessage("В папке не найдено поддерживаемых аудиофайлов (MP3, M4A, WAV, OGG, FLAC).");
        return false;
      }

      setMessage("Найдено " + tracks.length + " треков. Отправляем только названия и хеши, аудиофайлы остаются на компьютере…");
      const response = await fetch("/api/player/library", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + deviceToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tracks }),
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data.error || "Не удалось синхронизировать библиотеку.");
        return false;
      }

      fileMapRef.current = localFiles;
      setTrackCount(data.trackCount || 0);
      setLibraryReady(true);
      setMessage("Библиотека синхронизирована: " + data.trackCount + " треков. Файлы не загружались на сервер.");

      if (currentRequestRef.current) {
        try {
          await playLocalRequest(deviceToken, currentRequestRef.current, engineContext());
        } catch {
          setMessage("Не удалось восстановить текущий трек. Проверь, что файл остался в выбранной папке.");
        }
      }
      return true;
    } catch {
      setMessage("Ошибка при чтении папки или синхронизации. Попробуй ещё раз.");
      return false;
    } finally {
      syncingRef.current = false;
      setBusy(false);
    }
  }, [deviceToken, directory, engineContext]);

  useEffect(() => {
    syncLibraryRef.current = syncLibrary;
  }, [syncLibrary]);

  useEffect(() => {
    if (!deviceToken || !connected || !libraryReady) return;
    let stopped = false;
    let polling = false;

    const pollCommands = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const response = await fetch("/api/player/commands", {
          headers: { Authorization: "Bearer " + deviceToken },
          cache: "no-store",
        });
        if (!response.ok) {
          if (response.status === 401) setConnected(false);
          return;
        }

        const data = await response.json();
        for (const command of data.commands || []) {
          if (stopped) break;
          await executePlayerCommand(
            deviceToken,
            command,
            engineContext(),
            () => syncLibraryRef.current(),
          );
        }
      } catch {
        if (!stopped) setMessage("Не удалось получить команды. Повторяем подключение…");
      } finally {
        polling = false;
      }
    };

    void pollCommands();
    const timer = window.setInterval(() => { void pollCommands(); }, 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [deviceToken, connected, libraryReady, engineContext]);

  const handleTrackEnded = useCallback(async () => {
    if (!deviceToken) return;
    try {
      await finishCurrentTrack(deviceToken, engineContext());
    } catch {
      statusRef.current = "error";
      setPlayerStatus("error");
      setMessage("Не удалось сообщить серверу об окончании трека. Повторная синхронизация потребуется.");
    }
  }, [deviceToken, engineContext]);

  async function chooseOutput() {
    if (!navigator.mediaDevices?.selectAudioOutput) {
      setMessage("Выбор аудиовыхода браузером не поддерживается. Выбери устройство в микшере Windows.");
      return;
    }

    try {
      const device = await navigator.mediaDevices.selectAudioOutput();
      if (audioRef.current?.setSinkId) {
        await audioRef.current.setSinkId(device.deviceId);
      }
      setOutputDevice(device.label || "Выходное устройство выбрано");
      setMessage("Аудиовыход выбран. В OBS добавь это устройство отдельным источником.");
    } catch {
      setMessage("Не удалось выбрать аудиовыход.");
    }
  }

  return (
    <main className="shell player-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">F</span><span>FUSION<span className="brand-light"> / PLAYER</span></span></Link>
        <div className="top-right">
          <span className={"status " + (connected ? "connected" : "")}><i />{connected ? "PLAYER CONNECTED" : "PLAYER OFFLINE"}</span>
          <Link className="twitch-login" href="/dashboard">Панель владельца</Link>
        </div>
      </header>

      <section className="dashboard-intro">
        <p className="eyebrow">LOCAL PLAYER · PWA</p>
        <h1>Твой локальный <em>плеер</em></h1>
        <p>Сайт и очередь работают в облаке. Музыка воспроизводится с этого компьютера через отдельный аудиовыход.</p>
      </section>

      <section className="dashboard-card">
        <div className="dashboard-section-head">
          <div><p className="eyebrow">01 · CONNECTION</p><h2>Подключение</h2></div>
          <span className={"player-state " + (connected ? "is-online" : "")}>{connected ? "На связи" : "Ожидает подключения"}</span>
        </div>
        {connected ? (
          <p className="muted">Проигрыватель связан с сервером. Ключ хранится локально в зашифрованном IndexedDB.</p>
        ) : (
          <div className="player-connect">
            <input
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="Вставь одноразовый ключ из панели владельца"
            />
            <button className="dashboard-action" type="button" onClick={connectPlayer} disabled={busy}>Подключить</button>
          </div>
        )}
      </section>

      <section className="dashboard-card">
        <div className="dashboard-section-head">
          <div><p className="eyebrow">02 · LOCAL LIBRARY</p><h2>Музыкальная папка</h2></div>
          <span className="player-state">{trackCount ? trackCount + " треков синхронизировано" : "Не синхронизирована"}</span>
        </div>
        <p className="muted">{directory ? "Выбрана папка: " + directory.name : "Выбери папку, в которой лежат аудиофайлы с разрешением на трансляцию."}</p>
        <div className="player-actions">
          <button className="dashboard-action" type="button" onClick={chooseLibrary} disabled={busy}>Выбрать папку</button>
          <button className="dashboard-action" type="button" onClick={() => { void syncLibrary(); }} disabled={busy || !connected || !directory}>Сканировать и синхронизировать</button>
        </div>
        <p className="fine-print">На сервер отправляются только названия, формат, размер и хеш файла. Сами аудиофайлы и пути к ним остаются на компьютере. Добавляй только музыку, которую разрешено транслировать на Twitch.</p>
      </section>

      <section className="dashboard-card">
        <div className="dashboard-section-head">
          <div><p className="eyebrow">03 · PLAYBACK</p><h2>Сейчас играет</h2></div>
          <span className={"player-state " + (playerStatus === "playing" ? "is-online" : "")}>{playerStatus === "playing" ? "Воспроизведение" : playerStatus === "paused" ? "Пауза" : playerStatus === "error" ? "Ошибка" : "Ожидание"}</span>
        </div>
        {currentTrack ? <p className="now-playing-title">{currentTrack.title}</p> : <p className="muted">Пока ничего не воспроизводится.</p>}
        {currentTrack ? <p className="muted">{currentTrack.artist}</p> : null}
      </section>

      <section className="dashboard-card">
        <div className="dashboard-section-head">
          <div><p className="eyebrow">04 · OBS AUDIO</p><h2>Аудиовыход</h2></div>
          <span className="player-state">{outputDevice || "Не выбран"}</span>
        </div>
        <p className="muted">Выбери отдельный аудиовыход (например, виртуальный кабель), а затем добавь его в OBS как источник Audio Input Capture.</p>
        <button className="dashboard-action" type="button" onClick={chooseOutput}>Выбрать аудиоустройство</button>
        <audio ref={audioRef} className="player-audio-test" onEnded={() => { void handleTrackEnded(); }} />
      </section>

      <p className="dashboard-message">{message}</p>
    </main>
  );
}

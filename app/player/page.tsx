"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
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
): Promise<void> {
  for await (const entry of directory.values()) {
    if (result.length >= 2000) return;

    if (entry.kind === "directory") {
      await scanDirectory(entry, result);
      continue;
    }

    const fileHandle = entry as FusionFileHandle;
    const extension = fileHandle.name.split(".").pop()?.toLowerCase() || "";
    if (!SUPPORTED_FORMATS.has(extension)) continue;

    const file = await fileHandle.getFile();
    const name = parseFileName(file.name);
    result.push({
      hash: await hashFile(file),
      title: name.title.slice(0, 200),
      artist: name.artist.slice(0, 200),
      durationSeconds: null,
      album: null,
      format: extension,
      fileSize: file.size,
    });
  }
}

export default function PlayerPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [directory, setDirectory] = useState<FusionDirectoryHandle | null>(null);
  const [trackCount, setTrackCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Подготавливаем Fusion Player…");
  const [outputDevice, setOutputDevice] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  const sendHeartbeat = useCallback(async (token: string) => {
    const response = await fetch("/api/player/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "online", currentRequestId: null, clientVersion: "pwa-0.1.0" }),
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
        if (cancelled) return;
        if (savedToken) {
          setDeviceToken(savedToken);
          setMessage("Сохранённый ключ найден. Проверяем подключение…");
        } else {
          setMessage("Подключи Fusion Player одноразовым ключом из панели владельца.");
        }

        const savedDirectory = await loadLibraryDirectory();
        if (!cancelled && savedDirectory) {
          setDirectory(savedDirectory);
          setMessage(savedToken ? "Проверяем проигрыватель и локальную библиотеку…" : "Локальная папка найдена. Подключи проигрыватель.");
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
      const ok = await sendHeartbeat(token);
      if (!ok) {
        setMessage("Сервер не принял ключ. Проверь, что он не был отозван.");
        return;
      }
      await savePlayerToken(token);
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
      setMessage("Выбрана папка: " + handle.name + ". Теперь синхронизируй библиотеку.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Не удалось открыть папку. Разреши доступ и попробуй ещё раз.");
    }
  }

  async function syncLibrary() {
    if (!deviceToken) {
      setMessage("Сначала подключи Fusion Player.");
      return;
    }

    if (!directory) {
      setMessage("Сначала выбери папку с аудиофайлами.");
      return;
    }

    setBusy(true);
    setMessage("Сканируем локальную библиотеку…");
    try {
      let permission = await directory.queryPermission({ mode: "read" });
      if (permission !== "granted") {
        permission = await directory.requestPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        setMessage("Браузеру не разрешено читать эту папку.");
        return;
      }

      const tracks: LocalTrack[] = [];
      await scanDirectory(directory, tracks);
      if (!tracks.length) {
        setMessage("В папке не найдено поддерживаемых аудиофайлов (MP3, M4A, WAV, OGG, FLAC).");
        return;
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
        return;
      }

      setTrackCount(data.trackCount || 0);
      setMessage("Библиотека синхронизирована: " + data.trackCount + " треков. Файлы не загружались на сервер.");
    } catch {
      setMessage("Ошибка при чтении папки или синхронизации. Попробуй ещё раз.");
    } finally {
      setBusy(false);
    }
  }

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
          <button className="dashboard-action" type="button" onClick={syncLibrary} disabled={busy || !connected || !directory}>Сканировать и синхронизировать</button>
        </div>
        <p className="fine-print">На сервер отправляются только названия, длительность (если доступна), формат и хеш файла. Сами аудиофайлы и пути к ним остаются на компьютере. Добавляй только музыку, которую разрешено транслировать на Twitch.</p>
      </section>

      <section className="dashboard-card">
        <div className="dashboard-section-head">
          <div><p className="eyebrow">03 · OBS AUDIO</p><h2>Аудиовыход</h2></div>
          <span className="player-state">{outputDevice || "Не выбран"}</span>
        </div>
        <p className="muted">Выбери отдельный аудиовыход (например, виртуальный кабель), а затем добавь его в OBS как источник Audio Input Capture.</p>
        <button className="dashboard-action" type="button" onClick={chooseOutput}>Выбрать аудиоустройство</button>
        <audio ref={audioRef} className="player-audio-test" />
      </section>

      <p className="dashboard-message">{message}</p>
    </main>
  );
}

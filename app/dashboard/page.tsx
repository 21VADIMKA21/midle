"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Viewer = {
  displayName: string | null;
  login: string | null;
  role: "owner" | "moderator" | "vip" | null;
};

type PlayerDevice = {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
};

export default function DashboardPage() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [devices, setDevices] = useState<PlayerDevice[]>([]);
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Загружаем панель…");

  async function loadDevices() {
    const response = await fetch("/api/player/devices", { cache: "no-store" });
    const data = await response.json();
    if (response.ok) setDevices(data.devices || []);
    else setMessage(data.error || "Не удалось загрузить список проигрывателей.");
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        if (!data?.authenticated) {
          setAuthenticated(false);
          setMessage("Войди через Twitch, чтобы управлять Fusion Music.");
          return;
        }
        setAuthenticated(true);
        setViewer(data.user);
        if (data.user?.role !== "owner") {
          setMessage("Эта панель доступна только владельцу канала.");
          return;
        }
        await loadDevices();
        if (!cancelled) setMessage("Панель подключена к серверу.");
      } catch {
        if (!cancelled) setMessage("Не удалось связаться с сервером.");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  async function pairPlayer() {
    setBusy(true);
    setMessage("Создаём защищённое подключение…");
    try {
      const response = await fetch("/api/player/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fusion Player Windows" }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "Не удалось создать подключение.");
        return;
      }
      setPairToken(data.deviceToken);
      await loadDevices();
      setMessage("Проигрыватель создан. Скопируй ключ — повторно он не показывается.");
    } catch {
      setMessage("Не удалось создать подключение. Проверь соединение.");
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!pairToken) return;
    try {
      await navigator.clipboard.writeText(pairToken);
      setMessage("Ключ скопирован. Вставь его в Fusion Player на компьютере.");
    } catch {
      setMessage("Не удалось скопировать ключ. Выдели его и скопируй вручную.");
    }
  }

  async function revokeDevice(deviceId: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/player/devices/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "Не удалось отключить проигрыватель.");
        return;
      }
      setPairToken(null);
      await loadDevices();
      setMessage("Проигрыватель отключён. Его ключ больше не действует.");
    } catch {
      setMessage("Не удалось отключить проигрыватель.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell dashboard-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">F</span><span>FUSION<span className="brand-light"> / MUSIC</span></span></Link>
        <div className="top-right">
          <span className="channel">ПАНЕЛЬ ВЛАДЕЛЬЦА</span>
          <Link className="twitch-login" href="/">На главную</Link>
        </div>
      </header>

      <section className="dashboard-intro">
        <p className="eyebrow">CONTROL CENTER</p>
        <h1>Управление <em>Fusion Music</em></h1>
        <p>{viewer ? `Вход выполнен: ${viewer.displayName || viewer.login || "Twitch"}` : "Подключение к Twitch"}</p>
      </section>

      {!authenticated ? (
        <section className="dashboard-card">
          <h2>Нужен вход через Twitch</h2>
          <p>Авторизуйся под владельцем канала, чтобы подключить локальный проигрыватель.</p>
          <a className="twitch-login" href="/api/auth/twitch">Войти через Twitch ↗</a>
        </section>
      ) : viewer?.role !== "owner" ? (
        <section className="dashboard-card"><h2>Нет доступа</h2><p>У этой учётной записи нет прав владельца Fusion Music.</p></section>
      ) : (
        <section className="dashboard-card">
          <div className="dashboard-section-head">
            <div><p className="eyebrow">LOCAL PLAYER</p><h2>Проигрыватель</h2></div>
            <button className="dashboard-action" type="button" onClick={pairPlayer} disabled={busy || devices.length > 0}>
              {devices.length ? "Проигрыватель уже создан" : "Создать ключ подключения"}
            </button>
          </div>

          {devices.length ? devices.map((device) => (
            <div className="device-row" key={device.id}>
              <div><strong>{device.name}</strong><span>{device.status === "offline" ? "Не в сети" : "Подключён"} · {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "ещё не подключался"}</span></div>
              <button className="revoke-action" type="button" onClick={() => revokeDevice(device.id)} disabled={busy}>Отключить</button>
            </div>
          )) : <p className="muted">Пока нет подключённых проигрывателей. Создай ключ и введи его в приложении Fusion Player.</p>}

          {pairToken ? (
            <div className="pair-token">
              <p className="eyebrow">ONE-TIME DEVICE KEY</p>
              <code>{pairToken}</code>
              <button className="dashboard-action" type="button" onClick={copyToken}>Скопировать ключ</button>
              <p className="fine-print">Ключ отображается только один раз. Не отправляй его другим людям и не публикуй в чате.</p>
            </div>
          ) : null}
        </section>
      )}

      <p className="dashboard-message">{message}</p>
    </main>
  );
}

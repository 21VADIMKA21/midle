"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [requestsEnabled, setRequestsEnabled] = useState(false);
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Загружаем панель…");

  const loadDevices = useCallback(async () => {
    const response = await fetch("/api/player/devices", { cache: "no-store" });
    const data = await response.json();
    if (response.ok) {
      setDevices(data.devices || []);
      return true;
    }
    setMessage(data.error || "Не удалось загрузить список проигрывателей.");
    return false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const authStatus = new URLSearchParams(window.location.search).get("auth");
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        if (!data?.authenticated) {
          setAuthenticated(false);
          if (authStatus === "scope-missing") {
            setMessage("Twitch не выдал необходимые разрешения. Повтори подключение и подтверди доступ к чаттерам и модерации.");
          } else if (authStatus === "not-owner") {
            setMessage("Этот Twitch-аккаунт не является владельцем настроенного канала.");
          } else {
            setMessage("Войди через Twitch как владелец канала, чтобы настроить Fusion Music.");
          }
          return;
        }
        setAuthenticated(true);
        setViewer(data.user);
        if (data.user?.role !== "owner") {
          setMessage("Эта панель доступна только владельцу канала.");
          return;
        }
        const loaded = await loadDevices();
        if (!cancelled && loaded) setMessage("Панель подключена к серверу.");
      } catch {
        if (!cancelled) setMessage("Не удалось связаться с сервером.");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [loadDevices]);

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
      setMessage("Ключ скопирован. Сохрани его — позже введёшь в Fusion Player в Chrome/Edge.");
    } catch {
      setMessage("Не удалось скопировать ключ. Выдели его и скопируй вручную.");
    }
  }

  async function syncModerators() {
    setBusy(true);
    try {
      const response = await fetch("/api/channel/roles/sync", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "Не удалось синхронизировать модераторов.");
        return;
      }
      setMessage("Список модераторов Twitch обновлён: " + data.moderatorCount + ".");
    } catch {
      setMessage("Не удалось синхронизировать модераторов Twitch.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRequests() {
    setBusy(true);
    try {
      const response = await fetch("/api/channel/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestsEnabled: !requestsEnabled }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "Не удалось изменить приём заявок.");
        return;
      }
      setRequestsEnabled(data.requestsEnabled === true);
      setMessage(data.requestsEnabled ? "Приём заявок открыт." : "Приём заявок закрыт.");
    } catch {
      setMessage("Не удалось изменить приём заявок.");
    } finally {
      setBusy(false);
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
          <Link className="twitch-login" href="/api/auth/twitch/owner">Переподключить Twitch</Link>
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
          <a className="twitch-login" href="/api/auth/twitch/owner">Подключить канал через Twitch ↗</a>
        </section>
      ) : viewer?.role !== "owner" ? (
        <section className="dashboard-card"><h2>Нет доступа</h2><p>У этой учётной записи нет прав владельца Fusion Music.</p></section>
      ) : (
        <>
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
          )) : <p className="muted">Пока нет подключённых проигрывателей. Создай ключ. Когда будет готов Fusion Player в Chrome/Edge, вставь его туда.</p>}

          {pairToken ? (
            <div className="pair-token">
              <p className="eyebrow">ONE-TIME DEVICE KEY</p>
              <code>{pairToken}</code>
              <button className="dashboard-action" type="button" onClick={copyToken}>Скопировать ключ</button>
              <p className="fine-print">Ключ отображается только один раз. Не отправляй его другим людям и не публикуй в чате.</p>
            </div>
          ) : null}
        </section>

        <section className="dashboard-card">
          <div className="dashboard-section-head">
            <div><p className="eyebrow">REQUEST SETTINGS</p><h2>Приём заявок</h2></div>
            <span className={"player-state " + (requestsEnabled ? "is-online" : "")}>{requestsEnabled ? "Открыт" : "Закрыт"}</span>
          </div>
          <p className="muted">Заявки можно открыть только после подключения проигрывателя и синхронизации локальной библиотеки с музыкой, разрешённой для трансляции.</p>
          <button className="dashboard-action" type="button" onClick={toggleRequests} disabled={busy || (!requestsEnabled && devices.length === 0)}>
            {requestsEnabled ? "Закрыть приём заявок" : "Открыть приём заявок"}
          </button>
        </section>

        <section className="dashboard-card">
          <div className="dashboard-section-head">
            <div><p className="eyebrow">TWITCH MODERATION</p><h2>Модераторы</h2></div>
          </div>
          <p className="muted">Синхронизируй роли модераторов Twitch. После этого они смогут пропускать треки через панель и команды сервиса.</p>
          <button className="dashboard-action" type="button" onClick={syncModerators} disabled={busy}>Синхронизировать модераторов</button>
        </section>
        </>
      )}

      <p className="dashboard-message">{message}</p>
    </main>
  );
}

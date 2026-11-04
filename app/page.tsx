"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Track = {
  id: string;
  title: string;
  artist: string;
  requester: string | null;
  duration: string | null;
  artworkUrl: string | null;
  skipVotes?: number;
};

type Viewer = { displayName: string | null; login: string | null; role: "owner" | "moderator" | "vip" | null };
type CatalogTrack = { id: string; title: string; artist: string; durationSeconds: number | null; album: string | null };
type QueueResponse = {
  channel: { displayName: string | null; login: string | null } | null;
  currentTrack: Track | null;
  queue: Track[];
  player: { status: string };
  revision: number;
};

export default function Home() {
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [playerStatus, setPlayerStatus] = useState("loading");
  const [channelName, setChannelName] = useState("Fusion");
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [notice, setNotice] = useState("Подключаемся к серверу…");
  const [requestsEnabled, setRequestsEnabled] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState<CatalogTrack[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [requestingTrackId, setRequestingTrackId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [queueResponse, authResponse, settingsResponse] = await Promise.all([
          fetch("/api/queue", { cache: "no-store" }),
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/channel/settings", { cache: "no-store" }),
        ]);

        if (queueResponse.ok) {
          const data = (await queueResponse.json()) as QueueResponse;
          if (!cancelled) {
            setQueue(data.queue || []);
            setCurrentTrack(data.currentTrack || null);
            setPlayerStatus(data.player?.status || "offline");
            setChannelName(data.channel?.displayName || data.channel?.login || "Fusion");
            setNotice("Очередь синхронизирована с сервером.");
          }
        } else if (!cancelled) {
          setPlayerStatus("unavailable");
          setNotice("Серверная очередь пока не настроена. Демо-треки отключены.");
        }

        if (authResponse.ok) {
          const auth = await authResponse.json();
          if (!cancelled && auth?.authenticated) setViewer(auth.user);
        }

        if (settingsResponse.ok) {
          const settings = await settingsResponse.json();
          if (!cancelled) setRequestsEnabled(settings.requestsEnabled === true);
        }
      } catch {
        if (!cancelled) {
          setPlayerStatus("unavailable");
          setNotice("Не удалось подключиться к серверу. Попробуй обновить страницу позже.");
        }
      }
    }

    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const loadCatalog = useCallback(async (search: string) => {
    setCatalogLoading(true);
    try {
      const response = await fetch("/api/catalog?q=" + encodeURIComponent(search), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        setNotice(data.error || "Не удалось загрузить музыкальный каталог.");
        return;
      }
      setCatalogResults(data.tracks || []);
    } catch {
      setNotice("Не удалось загрузить музыкальный каталог.");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (requestsEnabled) void loadCatalog("");
    else setCatalogResults([]);
  }, [requestsEnabled, loadCatalog]);

  async function searchCatalog(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadCatalog(catalogQuery.trim());
  }

  async function requestTrack(trackId: string) {
    if (!viewer) {
      setNotice("Войди через Twitch, чтобы добавлять треки в очередь.");
      return;
    }
    if (!requestsEnabled) {
      setNotice("Приём заявок сейчас закрыт.");
      return;
    }

    setRequestingTrackId(trackId);
    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setNotice(data.error || "Не удалось добавить трек.");
        return;
      }
      setNotice(data.playerCommandQueued
        ? "Трек добавлен — проигрыватель получил команду запуска."
        : "Трек добавлен в очередь.");
      const queueResponse = await fetch("/api/queue", { cache: "no-store" });
      if (queueResponse.ok) {
        const queueData = await queueResponse.json() as QueueResponse;
        setQueue(queueData.queue || []);
        setCurrentTrack(queueData.currentTrack || null);
        setPlayerStatus(queueData.player?.status || "offline");
      }
    } catch {
      setNotice("Не удалось добавить трек. Проверь соединение.");
    } finally {
      setRequestingTrackId(null);
    }
  }

  async function logout() {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) setViewer(null);
    } catch {
      setNotice("Не удалось завершить сеанс. Проверь соединение и попробуй ещё раз.");
    }
  }

  async function voteToSkip() {
    try {
      const response = await fetch("/api/queue/vote", { method: "POST" });
      const result = await response.json();
      if (!response.ok) {
        setNotice(result.error || "Не удалось отправить голос.");
        return;
      }
      setCurrentTrack((track) => track
        ? { ...track, skipVotes: result.skipVotes }
        : track);
      setNotice(result.alreadyVoted ? `Твой голос уже учтён. Всего голосов: ${result.skipVotes}.` : `Голос за пропуск учтён. Всего голосов: ${result.skipVotes}.`);
    } catch {
      setNotice("Не удалось отправить голос. Проверь соединение.");
    }
  }

  const playerLabel =
    playerStatus === "playing" || playerStatus === "online" ? "PLAYER ONLINE" :
    playerStatus === "paused" ? "PLAYER PAUSED" :
    playerStatus === "loading" ? "CONNECTING" :
    "PLAYER OFFLINE";

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">F</span><span>FUSION<span className="brand-light"> / MUSIC</span></span></Link>
        <div className="top-right">
          <span className="status"><i /> СЕРВИС В РАЗРАБОТКЕ</span>
          {viewer?.role === "owner" ? <Link className="twitch-login" href="/dashboard">Панель ↗</Link> : null}
          {viewer
            ? <button className="twitch-login" type="button" onClick={logout}>Выйти ({viewer.displayName || viewer.login || "Twitch"})</button>
            : <a className="twitch-login" href="/api/auth/twitch">Войти через Twitch ↗</a>}
          <span className="channel">{channelName.toUpperCase()}</span>
        </div>
      </header>

      <section className="hero">
        <div><p className="eyebrow">COMMUNITY MUSIC PLAYER</p><h1>Твоя музыка.<br/><em>Наш общий эфир.</em></h1><p className="intro">Добавляй любимые треки в очередь и делай атмосферу стрима вместе с Fusion.</p></div>
        <div className="hero-orb"><div className="orb-core">F<span>♪</span></div><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/></div>
      </section>

      <section className="content-grid">
        <div className="main-column">
          <div className="section-head">
            <div><p className="eyebrow">NOW PLAYING</p><h2>Сейчас играет</h2></div>
            <span className="live-pill"><i/> {playerLabel}</span>
          </div>

          <article className="now-card">
            <div className="cover"><div className="cover-glow"/><span className="cover-label">FUSION<br/>FM</span><span className="cover-symbol">◉</span></div>
            {currentTrack ? (
              <div className="track-info"><span className="track-tag">СЕЙЧАС ИГРАЕТ</span><h3>{currentTrack.title}</h3><p>{currentTrack.artist}</p><div className="time-row"><span>Запросил: {currentTrack.requester || "зритель"}</span><span>{currentTrack.duration || "—"}</span></div><div className="skip-actions">{viewer ? <button className="skip-vote" type="button" onClick={voteToSkip}>Голосовать за скип · {currentTrack.skipVotes || 0}</button> : <a className="skip-vote" href="/api/auth/twitch">Войти, чтобы голосовать</a>}</div></div>
            ) : (
              <div className="track-info"><span className="track-tag">ПОКА ПУСТО</span><h3>Нет активного трека</h3><p>Здесь появится композиция, когда будет подключён проигрыватель.</p></div>
            )}
            <div className="playing-bars"><b/><b/><b/><b/><b/></div>
          </article>

          <div className="section-head queue-heading">
            <div><p className="eyebrow">UP NEXT</p><h2>Очередь <span className="count">{queue.length}</span></h2></div>
            <span className="muted">Порядок добавления</span>
          </div>
          <div className="queue-list">
            {queue.length ? queue.map((track, index) => (
              <div className="queue-item" key={track.id}>
                <span className="queue-number">{String(index + 1).padStart(2, "0")}</span>
                <div className="mini-cover">{track.title.slice(0, 1)}</div>
                <div className="queue-track"><strong>{track.title}</strong><span>{track.artist} · запросил {track.requester || "зритель"}</span></div>
                <span className="source">FUSION</span>
                <span className="duration">{track.duration || "—"}</span>
              </div>
            )) : <p className="muted">Очередь пока пуста. Демонстрационные композиции не используются.</p>}
          </div>
        </div>

        <aside className="side-column">
          <div className="request-card">
            <p className="eyebrow">YOUR TURN</p><h2>Добавить<br/>трек</h2>
            <p className="side-copy">{requestsEnabled ? "Найди композицию в каталоге, который владелец канала добавил для трансляции." : "Приём заявок пока закрыт. Он откроется после подключения локальной музыкальной библиотеки с правами на трансляцию."}</p>
            <form onSubmit={searchCatalog}>
              <label htmlFor="catalog-search">ПОИСК ПО НАЗВАНИЮ ИЛИ ИСПОЛНИТЕЛЮ</label>
              <input id="catalog-search" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Например, Artist — Track"/>
              <button type="submit" disabled={catalogLoading}>{catalogLoading ? "Ищем…" : "Найти трек"}</button>
            </form>
            {catalogResults.length ? (
              <div className="catalog-results">
                {catalogResults.map((track) => (
                  <div className="catalog-result" key={track.id}>
                    <div><strong>{track.title}</strong><span>{track.artist}</span></div>
                    <button type="button" onClick={() => void requestTrack(track.id)} disabled={!viewer || !requestsEnabled || requestingTrackId === track.id}>
                      {requestingTrackId === track.id ? "…" : "В очередь"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="fine-print">{requestsEnabled ? "Поищи трек по названию или исполнителю." : "Музыка не принимается по произвольным ссылкам. Используется только утверждённый каталог."}</p>
            )}
            {!viewer ? <a className="request-login" href="/api/auth/twitch">Войти через Twitch, чтобы отправлять заявки ↗</a> : null}
          </div>
          <div className="rules-card">
            <p className="eyebrow">КАК ЭТО БУДЕТ РАБОТАТЬ</p>
            <div className="rule"><span>01</span><p>Войти через Twitch</p></div>
            <div className="rule"><span>02</span><p>Отправить разрешённый трек</p></div>
            <div className="rule"><span>03</span><p>Следить за очередью на сайте</p></div>
          </div>
        </aside>
      </section>

      <footer><span>FUSION MUSIC <span className="brand-light">· COMMUNITY PLAYER</span></span><span>СДЕЛАНО ДЛЯ FUSION <b>✳</b></span></footer>
      <div className="toast">{notice}</div>
    </main>
  );
}

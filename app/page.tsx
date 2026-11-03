"use client";

import { useState } from "react";

type Track = { title: string; artist: string; requester: string; source: string; duration: string };
const initialQueue: Track[] = [
  { title: "Nightcall", artist: "Kavinsky", requester: "neonfox", source: "YouTube", duration: "4:18" },
  { title: "After Dark", artist: "Mr.Kitty", requester: "soul.exe", source: "YouTube Music", duration: "4:04" },
  { title: "Resonance", artist: "HOME", requester: "pixelwave", source: "YouTube", duration: "3:32" },
];

export default function Home() {
  const [queue, setQueue] = useState(initialQueue);
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("Это демонстрационный режим — заявки пока не сохраняются на сервере.");
  function addRequest(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!url.trim()) return;
    setNotice("Форма работает в режиме макета. Подключение источников и серверной очереди — следующий этап.");
    setUrl("");
  }
  return (
    <main className="shell">
      <header className="topbar"><a className="brand" href="#"><span className="brand-mark">F</span><span>FUSION<span className="brand-light"> / MUSIC</span></span></a><div className="top-right"><span className="status"><i /> СЕРВИС В РАЗРАБОТКЕ</span><a className="twitch-login" href="/api/auth/twitch">Войти через Twitch ↗</a><span className="channel">TWITCH CHANNEL</span></div></header>
      <section className="hero"><div><p className="eyebrow">COMMUNITY MUSIC PLAYER</p><h1>Твоя музыка.<br/><em>Наш общий эфир.</em></h1><p className="intro">Добавляй любимые треки в очередь и делай атмосферу стрима вместе с Fusion.</p></div><div className="hero-orb"><div className="orb-core">F<span>♪</span></div><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/></div></section>
      <section className="content-grid">
        <div className="main-column">
          <div className="section-head"><div><p className="eyebrow">NOW PLAYING</p><h2>Сейчас играет</h2></div><span className="live-pill"><i/> DEMO</span></div>
          <article className="now-card"><div className="cover"><div className="cover-glow"/><span className="cover-label">FUSION<br/>FM</span><span className="cover-symbol">◉</span></div><div className="track-info"><span className="track-tag">ПРИМЕР ТРЕКА</span><h3>Midnight City</h3><p>M83</p><div className="progress"><span/></div><div className="time-row"><span>1:42</span><span>4:03</span></div></div><div className="playing-bars"><b/><b/><b/><b/><b/></div></article>
          <div className="section-head queue-heading"><div><p className="eyebrow">UP NEXT</p><h2>Очередь <span className="count">{queue.length}</span></h2></div><span className="muted">Порядок добавления</span></div>
          <div className="queue-list">{queue.map((track, i) => <div className="queue-item" key={track.title}><span className="queue-number">{String(i + 1).padStart(2, "0")}</span><div className="mini-cover">{track.title.slice(0,1)}</div><div className="queue-track"><strong>{track.title}</strong><span>{track.artist} · запросил {track.requester}</span></div><span className="source">{track.source}</span><span className="duration">{track.duration}</span></div>)}</div>
        </div>
        <aside className="side-column"><div className="request-card"><p className="eyebrow">YOUR TURN</p><h2>Добавить<br/>трек</h2><p className="side-copy">Вставь ссылку на композицию — проверим источник и поставим её в очередь.</p><form onSubmit={addRequest}><label htmlFor="track-url">ССЫЛКА НА ТРЕК</label><input id="track-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://youtu.be/..." /><button type="submit">Добавить в очередь <span>↗</span></button></form><p className="fine-print">YouTube · YouTube Music · Spotify — поддержка будет подключена после проверки ограничений платформ.</p></div><div className="rules-card"><p className="eyebrow">КАК ЭТО РАБОТАЕТ</p><div className="rule"><span>01</span><p>Вставь ссылку на трек</p></div><div className="rule"><span>02</span><p>Дождись проверки и очереди</p></div><div className="rule"><span>03</span><p>Слушаем вместе на стриме</p></div></div></aside>
      </section>
      <footer><span>FUSION MUSIC <span className="brand-light">· COMMUNITY PLAYER</span></span><span>СДЕЛАНО ДЛЯ FUSION <b>✳</b></span></footer>
      <div className="toast">{notice}</div>
    </main>
  );
}

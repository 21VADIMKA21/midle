"use client";

import { useEffect, useState } from "react";

type QueuePayload = {
  channel: { displayName: string | null; login: string | null } | null;
  currentTrack: { title: string; artist: string; artworkUrl: string | null; requester: string | null; duration: string | null; skipVotes: number } | null;
  queue: Array<{ id: string; position: number; title: string; artist: string; artworkUrl: string | null; requester: string | null; duration: string | null; status: string }>;
  player: { status: string; lastSeenAt?: string | null };
  revision: number;
};

const EMPTY: QueuePayload = { channel: null, currentTrack: null, queue: [], player: { status: "offline" }, revision: 0 };

export default function OverlayPage() {
  const [data, setData] = useState<QueuePayload>(EMPTY);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch("/api/queue", { cache: "no-store" });
        if (!response.ok) throw new Error("queue unavailable");
        const next = await response.json() as QueuePayload;
        if (!stopped) { setData(next); setConnected(true); }
      } catch {
        if (!stopped) setConnected(false);
      } finally {
        if (!stopped) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  const track = data.currentTrack;
  const active = data.player.status === "playing" || data.player.status === "online";

  return (
    <main style={{ minHeight: "100vh", padding: 24, color: "#f4f2f7", background: "transparent", fontFamily: "Inter, Arial, sans-serif" }}>
      <section style={{ width: "min(720px, 100%)", overflow: "hidden", borderRadius: 22, background: "linear-gradient(135deg, rgba(17,15,24,.96), rgba(30,22,43,.96))", border: "1px solid rgba(190,150,255,.25)", boxShadow: "0 18px 60px rgba(0,0,0,.35)" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,.09)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, background: "#9b5de5", fontWeight: 900 }}>F</span>
            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 2 }}>FUSION <span style={{ color: "#b98cff" }}>/ MUSIC</span></span>
          </div>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: active ? "#8ee6b0" : "#c4b5d4" }}>
            <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 10, background: active ? "#69d99a" : "#887b98", marginRight: 7 }} />
            {connected ? (active ? "ПОДКЛЮЧЁН" : "ОЖИДАНИЕ") : "НЕТ СВЯЗИ"}
          </span>
        </header>
        <div style={{ display: "grid", gridTemplateColumns: "112px 1fr", gap: 18, padding: 20, alignItems: "center" }}>
          <div style={{ width: 112, height: 112, borderRadius: 14, overflow: "hidden", background: "#292333", display: "grid", placeItems: "center" }}>
            {track?.artworkUrl ? <img src={track.artworkUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 38, color: "#9b5de5" }}>♫</span>}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "#b98cff", fontWeight: 800, letterSpacing: 2, marginBottom: 8 }}>СЕЙЧАС ИГРАЕТ</div>
            <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15, overflowWrap: "anywhere" }}>{track?.title || "Пока ничего не играет"}</div>
            <div style={{ fontSize: 14, color: "#bcb4c8", marginTop: 6 }}>{track?.artist || "Ожидаем следующий трек"}</div>
            <div style={{ fontSize: 11, color: "#8f879b", marginTop: 10 }}>{track ? "Заказал: " + (track.requester || "Fusion") : "Очередь обновляется автоматически"}</div>
          </div>
        </div>
        <div style={{ padding: "0 20px 18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.8, color: "#b98cff" }}>ДАЛЬШЕ В ОЧЕРЕДИ</span>
            <span style={{ fontSize: 11, color: "#92899e" }}>{data.queue.length} трек(ов)</span>
          </div>
          {data.queue.length ? data.queue.slice(0, 4).map((item) => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid rgba(255,255,255,.07)" }}>
              <span style={{ width: 22, color: "#9e91ad", fontSize: 12, textAlign: "center" }}>{item.position}</span>
              {item.artworkUrl ? <img src={item.artworkUrl} alt="" style={{ width: 34, height: 34, borderRadius: 6, objectFit: "cover" }} /> : <span style={{ width: 34, height: 34, borderRadius: 6, background: "#292333", display: "grid", placeItems: "center", color: "#b98cff" }}>♫</span>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.title}</div>
                <div style={{ fontSize: 10, color: "#9c93a8", marginTop: 3 }}>{item.artist} · {item.requester || "зритель"} · {item.status === "pending" ? "ожидает проверки" : "в очереди"}</div>
              </div>
              <span style={{ fontSize: 10, color: "#9c93a8" }}>{item.duration || ""}</span>
            </div>
          )) : <div style={{ padding: "14px 0", fontSize: 12, color: "#8f879b" }}>Очередь пока пуста — закажи трек в чате.</div>}
        </div>
        <footer style={{ padding: "10px 20px", borderTop: "1px solid rgba(255,255,255,.08)", fontSize: 9, color: "#71687e", letterSpacing: 1.2 }}>
          {data.channel?.displayName || data.channel?.login || "FUSION"} · ОБНОВЛЕНИЕ АВТОМАТИЧЕСКОЕ
        </footer>
      </section>
    </main>
  );
}

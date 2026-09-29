import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellRing, Check, ExternalLink } from "lucide-react";
import "../../styles/notifications.css";

const API = import.meta.env.VITE_API_URL || "/api";
async function api(path, options = {}) {
  const response = await fetch(API + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.token}`,
        ...options.headers,
      },
    }),
    data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.message || "Notification request failed.");
  return data;
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false),
    [data, setData] = useState({ items: [], unread: 0 });
  const root = useRef(null);
  const load = useCallback(
    () =>
      api("/notifications")
        .then(setData)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  async function markAll() {
    await api("/notifications/read-all", { method: "PATCH" });
    await load();
  }
  async function openItem(item) {
    if (!item.readAt)
      await api(`/notifications/${item.id}/read`, { method: "PATCH" });
    setOpen(false);
    await load();
    if (item.link) window.location.assign(item.link);
  }
  return (
    <div className="notification-center" ref={root}>
      <button
        className="bell"
        onClick={() => setOpen((value) => !value)}
        aria-label={`${data.unread} unread notifications`}
      >
        <Bell />
        {data.unread > 0 && <span>{data.unread}</span>}
      </button>
      {open && (
        <section className="notification-popover">
          <header>
            <div>
              <BellRing />
              <span>
                <b>Notifications</b>
                <small>{data.unread} unread</small>
              </span>
            </div>
            {data.unread > 0 && (
              <button onClick={markAll}>
                <Check />
                Mark all read
              </button>
            )}
          </header>
          <div className="notification-items">
            {data.items.length ? (
              data.items.map((item) => (
                <button
                  key={item.id}
                  className={item.readAt ? "" : "unread"}
                  onClick={() => openItem(item)}
                >
                  <i data-type={item.type} />
                  <span>
                    <b>{item.title}</b>
                    <small>{item.message}</small>
                    <time>{new Date(item.createdAt).toLocaleString()}</time>
                  </span>
                  {item.link && <ExternalLink />}
                </button>
              ))
            ) : (
              <div className="notification-empty">
                <Bell />
                <b>You’re all caught up</b>
                <small>Classroom updates will appear here.</small>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import AuthView from "./features/auth/AccountAccess.jsx";
import ClassesWorkspace from "./features/classrooms/ClassesWorkspace.jsx";
import ClassActionModal from "./features/classrooms/ClassActionModal.jsx";
import QrCameraScanner from "./features/attendance/QrCameraScanner.jsx";
import FaceWorkspace, { LivenessCheck } from "./features/faces/FaceWorkspace.jsx";
import SettingsWorkspace from "./features/settings/SettingsWorkspace.jsx";
import NotificationCenter from "./features/notifications/NotificationCenter.jsx";
import SecureAttendance from "./features/attendance/SecureAttendance.jsx";
import PeopleWorkspace from "./features/people/PeopleWorkspace.jsx";
import ScheduleWorkspace from "./features/schedule/ScheduleWorkspace.jsx";
import ReportsWorkspace from "./features/reports/ReportsWorkspace.jsx";
import AdminWorkspace from "./features/admin/AdminWorkspace.jsx";
import { applyAppearance, watchSystemAppearance } from "./lib/appearance.js";
import "./styles/functional.css";
import "./styles/session.css";
import "./styles/profile-picture.css";
import "./styles/header.css";
import {
  BookOpen,
  BarChart3,
  CalendarDays,
  Camera,
  Check,
  Clock3,
  FileText,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Plus,
  QrCode,
  ScanFace,
  Search,
  Shield,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

if (localStorage.token) {
  let savedAppearance = { theme: "system", font: "dm-sans" };
  fetch(`${import.meta.env.VITE_API_URL || "/api"}/settings`, {
    headers: { Authorization: `Bearer ${localStorage.token}` },
  })
    .then((response) => (response.ok ? response.json() : savedAppearance))
    .then((settings) => {
      savedAppearance = settings;
      applyAppearance(settings);
      watchSystemAppearance(() => savedAppearance);
    })
    .catch(() => applyAppearance(savedAppearance));
}

// Preserve the existing route name while serving the complete settings workspace.
// eslint-disable-next-line no-func-assign
SettingsView = SettingsWorkspace;
// Preserve the existing route while replacing the earlier QR-only implementation.
// eslint-disable-next-line no-func-assign
RoleAttendance = SecureAttendance;

function ActionModal({ data, close, onSaved }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const response =
        data.type === "invite"
          ? await api(`/classrooms/${data.course.id}/invite`, {
              method: "POST",
              body: JSON.stringify(values),
            })
          : await api("/classrooms", {
              method: "POST",
              body: JSON.stringify(values),
            });
      setResult(response);
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section className="modal">
        <button className="x" onClick={close}>
          <X />
        </button>
        {result ? (
          <div className="success">
            <span>
              <Check />
            </span>
            <h2>
              {data.type === "invite" ? "Invitation sent" : "Classroom created"}
            </h2>
            <p>
              {data.type === "invite"
                ? `An invitation was sent to ${result.email}.`
                : `${result.name} is ready.`}
            </p>
            {result.link && (
              <label>
                Invitation link
                <input value={result.link} readOnly />
              </label>
            )}
            <button className="primary" onClick={close}>
              Done
            </button>
          </div>
        ) : (
          <>
            <small>
              {data.type === "invite" ? "INVITE STUDENT" : "NEW CLASSROOM"}
            </small>
            <h2>
              {data.type === "invite"
                ? `Invite to ${data.course.name}`
                : "Create a classroom"}
            </h2>
            <form onSubmit={submit}>
              {data.type === "invite" ? (
                <label>
                  Student email
                  <input
                    name="email"
                    type="email"
                    placeholder="student@university.edu"
                    required
                  />
                </label>
              ) : (
                <>
                  <label>
                    Class name
                    <input
                      name="name"
                      placeholder="Advanced Algorithms"
                      required
                    />
                  </label>
                  <label>
                    Subject / course code
                    <input name="subject" placeholder="CS 401" required />
                  </label>
                  <label>
                    Section
                    <input name="section" placeholder="Section A" />
                  </label>
                  <label>
                    Class color
                    <input name="color" type="color" defaultValue="#6556e8" />
                  </label>
                </>
              )}
              {error && <p className="error">{error}</p>}
              <button className="primary wide" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : data.type === "invite"
                    ? "Send invitation"
                    : "Create classroom"}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
function RealClasses({ user, modal, refresh }) {
  const [rooms, setRooms] = useState([]),
    [selected, setSelected] = useState(null),
    [members, setMembers] = useState([]),
    [error, setError] = useState("");
  useEffect(() => {
    api("/classrooms")
      .then(setRooms)
      .catch((e) => setError(e.message));
  }, [refresh]);
  async function openRoom(room) {
    setSelected(room);
    try {
      setMembers(await api(`/classrooms/${room.id}/members`));
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove(room, userId) {
    await api(`/classrooms/${room.id}/members/${userId}`, { method: "DELETE" });
    openRoom(room);
  }
  async function leave(room) {
    await api(`/classrooms/${room.id}/members/me`, { method: "DELETE" });
    setSelected(null);
    setRooms(await api("/classrooms"));
  }
  return (
    <>
      <Title
        over="CLASSROOM MANAGEMENT"
        title="My classes"
        text={
          user.role === "teacher"
            ? "Create classrooms, invite students, and manage rosters."
            : "Only teacher invitations can add you to a classroom."
        }
      >
        {user.role === "teacher" && (
          <button className="primary" onClick={() => modal({ type: "create" })}>
            <Plus />
            New classroom
          </button>
        )}
      </Title>
      {error && <p className="error">{error}</p>}
      {rooms.length ? (
        <div className="cards">
          {rooms.map((r) => (
            <article key={r.id} onClick={() => openRoom(r)}>
              <header style={{ background: r.color }}>
                <b>{r.subject}</b>
                <BookOpen />
              </header>
              <div>
                <h3>{r.name}</h3>
                <p>{r.section || "No section"}</p>
                <span>
                  <Users />
                  {r.memberCount || 0} students
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel empty-state">
          <BookOpen />
          <h3>No classrooms yet</h3>
          <p>
            {user.role === "teacher"
              ? "Create your first classroom."
              : "Join from an invitation link sent by your teacher."}
          </p>
        </section>
      )}
      {selected && (
        <section className="panel roster">
          <div className="roster-head">
            <div>
              <small>{selected.subject}</small>
              <h2>{selected.name}</h2>
            </div>
            <div>
              {user.role === "teacher" && (
                <button
                  className="outline"
                  onClick={() => modal({ type: "invite", course: selected })}
                >
                  <Mail />
                  Invite student
                </button>
              )}
              {user.role === "student" && (
                <button className="danger" onClick={() => leave(selected)}>
                  Leave class
                </button>
              )}
              <button className="icon-close" onClick={() => setSelected(null)}>
                <X />
              </button>
            </div>
          </div>
          <h3>People ({members.length})</h3>
          {members.length ? (
            members.map((m) => (
              <div className="member-row" key={m.id}>
                <span className="avatar">
                  {m.name
                    .split(" ")
                    .map((x) => x[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <div>
                  <b>{m.name}</b>
                  <small>
                    {m.email} · {m.identifier || "No ID"}
                  </small>
                </div>
                {user.role === "teacher" && (
                  <button
                    className="danger small"
                    onClick={() => remove(selected, m.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))
          ) : (
            <p>No students have joined yet.</p>
          )}
        </section>
      )}
    </>
  );
}

function RoleAttendance({ user }) {
  const [rooms, setRooms] = useState([]),
    [roomId, setRoomId] = useState(""),
    [roomNumber, setRoomNumber] = useState(""),
    [radius, setRadius] = useState(75),
    [session, setSession] = useState(null),
    [payload, setPayload] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/classrooms")
      .then((r) => {
        setRooms(r);
        if (r[0]) setRoomId(r[0].id);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  async function generate() {
    if (!roomId || !roomNumber)
      return setMessage("Choose a classroom and enter its room number.");
    setBusy(true);
    setMessage("");
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        try {
          const s = await api(`/classrooms/${roomId}/sessions`, {
            method: "POST",
            body: JSON.stringify({
              roomNumber,
              radius,
              lat: p.coords.latitude,
              lng: p.coords.longitude,
            }),
          });
          setSession(s);
        } catch (e) {
          setMessage(e.message);
        } finally {
          setBusy(false);
        }
      },
      () => {
        setBusy(false);
        setMessage("Location permission is required.");
      },
      { enableHighAccuracy: true },
    );
  }
  async function finalize() {
    try {
      await api(`/sessions/${session.id}/finalize`, { method: "POST" });
      setMessage("Attendance finalized and saved.");
      setSession(null);
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function checkIn(scannedPayload = payload) {
    setPayload(scannedPayload);
    let parsed;
    try {
      parsed = JSON.parse(scannedPayload);
    } catch {
      return setMessage("This is not a valid Classmark attendance QR code.");
    }
    if (
      parsed.type !== "classmark-attendance" ||
      !parsed.sessionId ||
      !parsed.code
    )
      return setMessage(
        "This QR code does not belong to a Classmark attendance session.",
      );
    setBusy(true);
    setMessage("QR recognized. Verifying your location…");
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        try {
          const r = await api("/attendance/check-in", {
            method: "POST",
            body: JSON.stringify({
              sessionId: parsed.sessionId,
              code: parsed.code,
              lat: p.coords.latitude,
              lng: p.coords.longitude,
            }),
          });
          setMessage(`${r.message} Reported distance: ${r.distance}m.`);
        } catch (e) {
          setMessage(e.message);
        } finally {
          setBusy(false);
        }
      },
      () => {
        setBusy(false);
        setMessage("Location permission is required to register attendance.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  if (user.role === "student")
    return (
      <>
        <Title
          over="SECURE ATTENDANCE"
          title="Scan attendance QR"
          text="Use your phone camera to scan the teacher’s live QR code, then verify your location."
        />
        <section className="panel student-checkin">
          <QrCode />
          <h3>Scan the teacher’s QR code</h3>
          <p>
            The code is valid for five minutes. Camera and precise location
            permission are required.
          </p>
          <QrCameraScanner onScan={checkIn} disabled={busy} />
          <details className="manual-qr">
            <summary>Having camera trouble?</summary>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="Paste decoded Classmark QR data"
            />
            <button
              className="outline"
              onClick={() => checkIn()}
              disabled={busy}
            >
              <MapPin />
              {busy ? "Verifying…" : "Verify pasted code"}
            </button>
          </details>
          {message && <p className="status-message">{message}</p>}
        </section>
      </>
    );
  return (
    <>
      <Title
        over="LOCATION-VERIFIED"
        title="Take attendance"
        text="Generate a five-minute QR code from a real classroom."
      />
      <div className="attend">
        <section className="panel session">
          <label>
            Classroom
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Select a classroom</option>
              {rooms.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.subject} — {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Room number
            <input
              value={roomNumber}
              onChange={(e) => setRoomNumber(e.target.value)}
              placeholder="Room 302"
            />
          </label>
          <label>
            Allowed proximity <b>{radius} metres</b>
            <input
              type="range"
              min="10"
              max="100"
              step="5"
              value={radius}
              onChange={(e) => setRadius(+e.target.value)}
            />
          </label>
          <button
            className="primary wide"
            onClick={generate}
            disabled={busy || !rooms.length}
          >
            <MapPin />
            {busy ? "Locating…" : "Generate secure QR"}
          </button>
          {!rooms.length && (
            <p className="error">
              Create a classroom before taking attendance.
            </p>
          )}
          {message && <p className="status-message">{message}</p>}
        </section>
        <section className="panel qr">
          {session ? (
            <>
              <span className="live">● LIVE SESSION</span>
              <img src={session.qrDataUrl} alt="Attendance QR" />
              <h3>{roomNumber}</h3>
              <Timer
                until={new Date(session.expiresAt).getTime()}
                expire={() => {}}
              />
              <button className="outline" onClick={finalize}>
                Finalize now
              </button>
            </>
          ) : (
            <div>
              <span>
                <QrCode />
              </span>
              <h3>QR code appears here</h3>
              <p>Choose a classroom and verify your location.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
const API = import.meta.env.VITE_API_URL || "/api";
const courses = [];
const api = (path, options = {}) =>
  fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(localStorage.token
        ? { Authorization: `Bearer ${localStorage.token}` }
        : {}),
    },
  }).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw Error(d.message);
    return d;
  });
const Mark = () => (
  <span className="mark">
    <Check />
  </span>
);
function RealHome({ setPage, modal, user }) {
  const [rooms, setRooms] = useState([]),
    [overview, setOverview] = useState({
      attendanceRecords: 0,
      sessionsToday: 0,
      classesToday: 0,
    }),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      offsetMinutes = new Date().getTimezoneOffset(),
      overviewQuery = new URLSearchParams({
        timezone: timeZone,
        offsetMinutes: String(offsetMinutes),
        refreshedAt: String(Date.now()),
      });
    Promise.all([
      api("/classrooms"),
      api(`/overview?${overviewQuery.toString()}`),
    ])
      .then(([classrooms, summary]) => {
        setRooms(classrooms);
        setOverview(summary);
      })
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);
  const students = rooms.reduce((sum, r) => sum + (r.memberCount || 0), 0);
  return (
    <>
      <div className="welcome">
        <div>
          <small>TODAY</small>
          <h1>Welcome, {user.name} 👋</h1>
          <p>Your real classroom activity is shown below.</p>
        </div>
        {user.role === "teacher" && (
          <button className="primary" onClick={() => setPage("attendance")}>
            <QrCode />
            Take attendance
          </button>
        )}
      </div>
      <div className="stats">
        <Stat
          I={BookOpen}
          label="Active classes"
          value={rooms.length}
          note="Current classrooms"
          tone="violet"
        />
        <Stat
          I={Users}
          label="Total students"
          value={students}
          note="Across your classes"
          tone="orange"
        />
        <Stat
          I={Check}
          label="Attendance records"
          value={overview.attendanceRecords}
          note={
            user.role === "teacher"
              ? "Student results recorded"
              : "Your recorded results"
          }
          tone="green"
        />
        <Stat
          I={CalendarDays}
          label="Classes today"
          value={overview.classesToday}
          note={`${overview.sessionsToday} attendance sessions started`}
          tone="blue"
        />
      </div>
      {loading ? (
        <section className="panel empty-state">
          <p>Loading classrooms…</p>
        </section>
      ) : rooms.length ? (
        <section className="panel classroom">
          <Head over="CLASSROOMS" title="Your active classes" />
          <div className="cards">
            {rooms.map((r) => (
              <article key={r.id}>
                <header style={{ background: r.color }}>
                  <b>{r.subject}</b>
                  <BookOpen />
                </header>
                <div>
                  <h3>{r.name}</h3>
                  <p>{r.section || "No section"}</p>
                  <span>
                    <Users />
                    {r.memberCount || 0} students
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel empty-state">
          <BookOpen />
          <h3>No classrooms yet</h3>
          <p>
            {user.role === "teacher"
              ? "Create your first classroom and invite students."
              : "Invited classrooms will appear here."}
          </p>
          {user.role === "teacher" && (
            <button className="primary" onClick={modal}>
              <Plus />
              Create classroom
            </button>
          )}
        </section>
      )}
    </>
  );
}

function Auth({ enter }) {
  const [register, setRegister] = useState(false),
    [role, setRole] = useState("teacher"),
    [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setError("");
    const body = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const r = await api("/auth/" + (register ? "register" : "login"), {
        method: "POST",
        body: JSON.stringify({ ...body, role }),
      });
      localStorage.token = r.token;
      enter(r.user);
    } catch (x) {
      setError(
        x.message === "Failed to fetch"
          ? "Cannot reach the API. Run “npm run dev” or “npm run server”, then retry."
          : x.message,
      );
    }
  }
  return (
    <div className="auth">
      <section className="auth-art">
        <b className="logo light">
          <Mark /> Classmark
        </b>
        <div>
          <span className="pill">✦ Attendance, reimagined</span>
          <h1>
            Every class.
            <br />
            Every face.
            <br />
            <em>Effortlessly present.</em>
          </h1>
          <p>
            Secure facial recognition and location-verified QR attendance for
            modern campuses.
          </p>
          <footer>
            <span>
              <ScanFace /> Face verified
            </span>
            <span>
              <MapPin /> Location secured
            </span>
            <span>
              <ShieldCheck /> Private by design
            </span>
          </footer>
        </div>
      </section>
      <section className="auth-form">
        <form onSubmit={submit}>
          <b className="logo mobile">
            <Mark /> Classmark
          </b>
          <small>{register ? "GET STARTED" : "WELCOME BACK"}</small>
          <h2>
            {register ? "Create your account" : "Sign in to your account"}
          </h2>
          <p>
            {register
              ? "Use any valid email for this development build."
              : "Enter your details to access your dashboard."}
          </p>
          {register && (
            <label>
              Full name
              <input name="name" placeholder="Dr. Ananya Sen" required />
            </label>
          )}
          <label>
            Email address
            <input
              name="email"
              type="email"
              placeholder="name@university.edu"
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength="8"
              placeholder="At least 8 characters"
              required
            />
          </label>
          {register && (
            <div className="roles">
              <button
                type="button"
                className={role === "teacher" ? "on" : ""}
                onClick={() => setRole("teacher")}
              >
                <BookOpen />
                Teacher
              </button>
              <button
                type="button"
                className={role === "student" ? "on" : ""}
                onClick={() => setRole("student")}
              >
                <Users />
                Student
              </button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <button className="primary wide">
            {register ? "Create account" : "Sign in"}
          </button>
          <p className="switch">
            {register ? "Already registered?" : "New to Classmark?"}{" "}
            <button type="button" onClick={() => setRegister(!register)}>
              {register ? "Sign in" : "Create account"}
            </button>
          </p>
          <div className="or">or preview immediately</div>
          <button
            type="button"
            className="outline wide"
            onClick={() => enter({ name: "Dr. Ananya Sen", role: "teacher" })}
          >
            Open teacher demo
          </button>
        </form>
      </section>
    </div>
  );
}

async function loadProfilePicture(userId) {
  const response = await fetch(`${API}/profile/picture/${userId}`, {
    headers: { Authorization: `Bearer ${localStorage.token}` },
  });
  if (response.status === 404) return "";
  if (!response.ok) throw Error("Could not load profile picture.");
  return URL.createObjectURL(await response.blob());
}
function ProfileAvatar({ user }) {
  const [picture, setPicture] = useState("");
  useEffect(() => {
    let current = true,
      objectUrl = "";
    async function load() {
      try {
        const next = await loadProfilePicture(user.id);
        if (!current) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
        setPicture(next);
      } catch {
        if (current) setPicture("");
      }
    }
    load();
    const refresh = () => load();
    window.addEventListener("profile-picture-updated", refresh);
    return () => {
      current = false;
      window.removeEventListener("profile-picture-updated", refresh);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [user.id]);
  return (
    <span className="profile-avatar">
      {picture ? (
        <img src={picture} alt={`${user.name} profile`} />
      ) : (
        user.name
          .split(" ")
          .map((x) => x[0])
          .slice(0, 2)
          .join("")
      )}
    </span>
  );
}
function Side({ page, setPage, user, logout, open, setOpen }) {
  const links =
    user.role === "admin"
      ? [
          ["admin", Shield, "Administration"],
          ["reports", BarChart3, "Reports"],
          ["face", ScanFace, "Face setup"],
          ["settings", Settings, "Settings"],
        ]
      : user.role === "teacher"
      ? [
          ["home", LayoutDashboard, "Overview"],
          ["classes", BookOpen, "My classes"],
          ["attendance", QrCode, "Take attendance"],
          ["face", ScanFace, "Face setup"],
          ["people", Users, "People"],
          ["schedule", CalendarDays, "Schedule"],
          ["reports", BarChart3, "Reports"],
          ["settings", Settings, "Settings"],
        ]
      : [
          ["home", LayoutDashboard, "Overview"],
          ["classes", BookOpen, "My classes"],
          ["attendance", QrCode, "QR check-in"],
          ["face", ScanFace, "Face setup"],
          ["schedule", CalendarDays, "Schedule"],
          ["reports", BarChart3, "My attendance"],
          ["settings", Settings, "Settings"],
        ];
  return (
    <aside className={"side " + (open ? "open" : "")}>
      <b className="logo">
        <Mark />
        Classmark
      </b>
      <button className="nav-x" onClick={() => setOpen(false)}>
        <X />
      </button>
      <nav>
        {links.map(([p, I, t]) => (
          <button
            className={page === p ? "active" : ""}
            onClick={() => {
              setPage(p);
              setOpen(false);
            }}
            key={p}
          >
            <I />
            {t}
          </button>
        ))}
      </nav>
      <div className="side-foot">
        <div className="user">
          <ProfileAvatar user={user} />
          <div>
            <b>{user.name}</b>
            <small>{user.role}</small>
          </div>
          <button onClick={logout}>
            <LogOut />
          </button>
        </div>
      </div>
    </aside>
  );
}
function Top({ title, open, user, setPage }) {
  const searchRef = useRef(null),
    searchRoot = useRef(null),
    [query, setQuery] = useState(""),
    [results, setResults] = useState([]),
    [searching, setSearching] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [mobileSearch, setMobileSearch] = useState(false);
  useEffect(() => {
    const focusSearch = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileSearch(true);
        setSearchOpen(true);
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMobileSearch(false);
        searchRef.current?.blur();
      }
    };
    const closeSearch = (event) => {
      if (!searchRoot.current?.contains(event.target)) setSearchOpen(false);
    };
    window.addEventListener("keydown", focusSearch);
    document.addEventListener("pointerdown", closeSearch);
    return () => {
      window.removeEventListener("keydown", focusSearch);
      document.removeEventListener("pointerdown", closeSearch);
    };
  }, []);
  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) return undefined;
    const controller = new AbortController(),
      timer = setTimeout(() => {
        setSearching(true);
        api(`/search?q=${encodeURIComponent(normalized)}`, {
          signal: controller.signal,
        })
          .then((data) => {
            setResults(data.items || []);
            setSearchOpen(true);
          })
          .catch((error) => {
            if (error.name !== "AbortError") setResults([]);
          })
          .finally(() => setSearching(false));
      }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  function openResult(item) {
    setPage(item.page);
    if (item.classroomId)
      window.dispatchEvent(
        new CustomEvent("classmark:navigate", {
          detail: {
            page: item.page,
            classroomId: item.classroomId,
            tab: item.tab,
            assignmentId: item.assignmentId || "",
          },
        }),
      );
    setQuery("");
    setResults([]);
    setSearchOpen(false);
    setMobileSearch(false);
  }
  return (
    <header className="top">
      <button
        className="hamb top-icon-button"
        onClick={open}
        aria-label="Open navigation"
      >
        <Menu />
      </button>
      <div className="top-title">
        <small>CLASSMARK PORTAL</small>
        <h3>{title}</h3>
      </div>
      <div
        className={`top-search ${mobileSearch ? "open" : ""}`}
        ref={searchRoot}
      >
        <Search />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            setResults([]);
            setSearching(value.trim().length >= 2);
          }}
          onFocus={() => setSearchOpen(true)}
          placeholder="Search classes, people and work"
          aria-label="Search classrooms, people, assignments, and resources"
          autoComplete="off"
        />
        <kbd>Ctrl K</kbd>
        {searchOpen && query.trim().length >= 2 && (
          <section className="search-results" aria-live="polite">
            {searching ? (
              <p>Searching…</p>
            ) : results.length ? (
              results.map((item, index) => (
                <button
                  key={`${item.type}-${item.classroomId || "system"}-${item.assignmentId || item.title}-${index}`}
                  onClick={() => openResult(item)}
                >
                  <span className={`search-result-icon ${item.type}`}>
                    {item.type === "classroom" ? <BookOpen /> : item.type === "assignment" ? <FileText /> : item.type === "resource" ? <Link2 /> : <Users />}
                  </span>
                  <span><b>{item.title}</b><small>{item.subtitle}</small></span>
                  <em>{item.type}</em>
                </button>
              ))
            ) : (
              <p>No accessible results for “{query.trim()}”.</p>
            )}
          </section>
        )}
      </div>
      <div className="top-actions">
        <button
          className="search-mobile top-icon-button"
          onClick={() => {
            setMobileSearch((value) => !value);
            setTimeout(() => searchRef.current?.focus(), 0);
          }}
          aria-label="Open global search"
        >
          <Search />
        </button>
        {user.role !== "admin" && <NotificationCenter />}
        <button
          className="top-profile"
          onClick={() => setPage("settings")}
          aria-label="Open profile settings"
        >
          <ProfileAvatar user={user} />
          <span>
            <b>{user.name}</b>
            <small>{user.role}</small>
          </span>
        </button>
      </div>
    </header>
  );
}

function AdminLoginVerification({ user, onVerified, onSignOut }) {
  const [session, setSession] = useState(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function begin() {
    setBusy(true);
    setMessage("");
    try {
      setSession(await api("/admin/auth/session", { method: "POST" }));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    setBusy(true);
    setMessage("Confirming your administrator identity…");
    try {
      const result = await api("/admin/auth/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      localStorage.token = result.token;
      onVerified(result.user);
    } catch (error) {
      setSession(null);
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="face-onboarding">
      <header className="onboarding-brand">
        <Mark />
        <b>Classmark administration</b>
        <button onClick={onSignOut} title="Sign out of this administrator account">
          Sign out
        </button>
      </header>
      <main>
        <div className="onboarding-callout">
          <ShieldCheck />
          <div>
            <small>MANDATORY LOGIN VERIFICATION</small>
            <h1>Confirm your administrator identity</h1>
            <p>
              {user.name}, complete a fresh AWS live-face check before this
              privileged dashboard is unlocked.
            </p>
          </div>
        </div>
        <section className="panel biometric-status">
          <div className="status-icon"><ScanFace /></div>
          <div>
            <small>ADMINISTRATOR SECURITY</small>
            <h2>Live verification required</h2>
            <p>Photos, screens, objects, and partial faces are rejected.</p>
          </div>
          <button className="primary" onClick={begin} disabled={busy} title="Start the mandatory live-face check">
            <ScanFace />{busy ? "Starting…" : "Verify and continue"}
          </button>
        </section>
        {message && <p className="status-message">{message}</p>}
      </main>
      {session && (
        <LivenessCheck
          enrollment={session}
          over="ADMINISTRATOR LOGIN"
          title="Verify your live face"
          text="Keep this page visible and follow the movement prompt to unlock the dashboard."
          onComplete={complete}
          onCancel={(reason) => {
            setSession(null);
            if (reason) setMessage(reason);
          }}
        />
      )}
    </div>
  );
}

function useProjectTooltips() {
  useEffect(() => {
    const apply = (root = document) => {
      root
        .querySelectorAll?.("button:not([title]), a:not([title]), select:not([title]), input:not([title]), textarea:not([title])")
        .forEach((element) => {
          const label = element.getAttribute("aria-label") ||
            element.closest("label")?.childNodes?.[0]?.textContent?.trim() ||
            element.textContent?.trim() ||
            element.getAttribute("placeholder");
          if (!label) return;
          const action = element.matches("select")
            ? `Choose ${label.toLowerCase()}`
            : element.matches("input, textarea")
              ? `Enter or update ${label.toLowerCase()}`
              : label;
          element.title = action.replace(/\s+/g, " ").slice(0, 160);
        });
    };
    apply();
    const observer = new MutationObserver(() => apply());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}
const Stat = ({ I, label, value, note, tone }) => (
  <article className="stat">
    <span className={tone}>
      <I />
    </span>
    <div>
      <small>{label}</small>
      <b>{value}</b>
      <em>{note}</em>
    </div>
  </article>
);
function Home({ setPage, modal }) {
  return (
    <>
      <div className="welcome">
        <div>
          <small>SATURDAY, SEPTEMBER 26</small>
          <h1>Good morning, Ananya 👋</h1>
          <p>Here’s what’s happening with your classes today.</p>
        </div>
        <button className="primary" onClick={() => setPage("attendance")}>
          <QrCode />
          Take attendance
        </button>
      </div>
      <div className="stats">
        <Stat
          I={BookOpen}
          label="Active classes"
          value="3"
          note="This semester"
          tone="violet"
        />
        <Stat
          I={Users}
          label="Total students"
          value="131"
          note="Across all classes"
          tone="orange"
        />
        <Stat
          I={Check}
          label="Avg. attendance"
          value="91.2%"
          note="↑ 2.4% this month"
          tone="green"
        />
        <Stat
          I={CalendarDays}
          label="Classes today"
          value="3"
          note="Next at 10:30 AM"
          tone="blue"
        />
      </div>
      <div className="columns">
        <section className="panel">
          <Head over="TODAY" title="Your schedule" />
          <div className="schedule">
            {courses.map((c) => (
              <div key={c.id}>
                <time>
                  {c.time}
                  <small>60 min</small>
                </time>
                <i style={{ background: c.color }} />
                <section>
                  <small style={{ color: c.color }}>{c.code}</small>
                  <b>{c.name}</b>
                  <span>
                    <MapPin />
                    {c.room} · {c.section}
                  </span>
                </section>
                <span>
                  <Users />
                  {c.students}
                </span>
                <button onClick={() => setPage("attendance")}>
                  <QrCode />
                  Start
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="panel quick">
          <Head over="SHORTCUTS" title="Quick actions" />
          <button onClick={() => setPage("attendance")}>
            <QrCode />
            <span>
              <b>Generate attendance QR</b>
              <small>Valid for 5 minutes</small>
            </span>
            →
          </button>
          <button onClick={() => setPage("face")}>
            <ScanFace />
            <span>
              <b>Set up face profile</b>
              <small>Secure camera enrollment</small>
            </span>
            →
          </button>
          <button onClick={modal}>
            <Plus />
            <span>
              <b>Create a classroom</b>
              <small>Invite students by email</small>
            </span>
            →
          </button>
        </section>
      </div>
      <ClassGrid invite={() => {}} />
    </>
  );
}
const Head = ({ over, title }) => (
  <div className="head">
    <div>
      <small>{over}</small>
      <h3>{title}</h3>
    </div>
  </div>
);
function ClassGrid({ invite }) {
  return (
    <section className="panel classroom">
      <Head over="CLASSROOMS" title="Your active classes" />
      <div className="cards">
        {courses.map((c) => (
          <article key={c.id}>
            <header style={{ background: c.color }}>
              <b>{c.code}</b>
              <BookOpen />
            </header>
            <div>
              <h3>{c.name}</h3>
              <p>
                {c.section} · {c.room}
              </p>
              <span>
                <Users />
                {c.students} students <b>{c.rate}%</b>
              </span>
              <em>
                <i style={{ width: c.rate + "%", background: c.color }} />
              </em>
              {invite && (
                <button className="outline wide" onClick={() => invite(c)}>
                  <Mail />
                  Invite students
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function Classes({ modal }) {
  return (
    <>
      <Title
        over="CLASSROOM MANAGEMENT"
        title="My classes"
        text="Create classrooms, invite students, and control every class you teach."
      >
        <button className="primary" onClick={() => modal({ type: "create" })}>
          <Plus />
          New classroom
        </button>
      </Title>
      <ClassGrid invite={(c) => modal({ type: "invite", course: c })} />
    </>
  );
}
function Title({ over, title, text, children }) {
  return (
    <div className="title">
      <div>
        <small>{over}</small>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {children}
    </div>
  );
}
function Attendance() {
  const [room, setRoom] = useState(""),
    [radius, setRadius] = useState(75),
    [course, setCourse] = useState("cs401"),
    [qr, setQr] = useState(""),
    [until, setUntil] = useState(0),
    [error, setError] = useState("");
  async function make() {
    if (!room) return setError("Enter a classroom number first.");
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const expiresAt = Date.now() + 300000,
          set = {
            type: "classmark-attendance",
            course,
            room,
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            radius,
            expiresAt,
            nonce: crypto.randomUUID(),
          };
        setQr(
          await QRCode.toDataURL(JSON.stringify(set), {
            width: 500,
            margin: 2,
          }),
        );
        setUntil(expiresAt);
        setError("");
      },
      () => setError("Location permission is required."),
    );
  }
  return (
    <>
      <Title
        over="LOCATION-VERIFIED"
        title="Take attendance"
        text="Generate a secure QR code tied to your live location and classroom."
      />
      <div className="attend">
        <section className="panel session">
          <b className="step">1</b>
          <h3>Session details</h3>
          <p>Students must be within the selected radius.</p>
          <label>
            Choose class
            <select value={course} onChange={(e) => setCourse(e.target.value)}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Classroom number
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="e.g. Room 302"
            />
          </label>
          <label>
            Allowed proximity <b>{radius} metres</b>
            <input
              type="range"
              min="10"
              max="100"
              step="5"
              value={radius}
              onChange={(e) => setRadius(+e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary wide" onClick={make}>
            <MapPin />
            Verify location & generate QR
          </button>
          <aside>
            <ShieldCheck />
            <span>
              <b>Strict verification</b>Both locations, enrollment, and the
              five-minute window must pass.
            </span>
          </aside>
        </section>
        <section className="panel qr">
          {qr ? (
            <>
              <span className="live">● LIVE SESSION</span>
              <img src={qr} />
              <h3>{courses.find((c) => c.id === course).name}</h3>
              <p>
                {room} · {radius}m radius
              </p>
              <Timer until={until} expire={() => setQr("")} />
              <small>Attendance finalizes when this code expires.</small>
            </>
          ) : (
            <div>
              <span>
                <QrCode />
              </span>
              <h3>Your QR code appears here</h3>
              <p>Complete session details and verify your location.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
function Timer({ until, expire }) {
  const [left, setLeft] = useState(300000),
    expireRef = useRef(expire);
  useEffect(() => {
    expireRef.current = expire;
  }, [expire]);
  useEffect(() => {
    const tick = () => {
      const n = Math.max(0, until - Date.now());
      setLeft(n);
      if (!n) expireRef.current();
    };
    tick();
    const x = setInterval(tick, 1000);
    return () => clearInterval(x);
  }, [until]);
  const s = Math.ceil(left / 1000);
  return (
    <b className="timer">
      <Clock3 />
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} remaining
    </b>
  );
}
function SettingsView({ user }) {
  const [form, setForm] = useState({
      name: user.name || "",
      department: user.department || "",
      identifier: user.identifier || "",
      theme: "light",
      font: "dm-sans",
      emailNotifications: true,
      attendanceNotifications: true,
      invitationNotifications: true,
    }),
    [photo, setPhoto] = useState(""),
    [pendingPhoto, setPendingPhoto] = useState(""),
    [message, setMessage] = useState(""),
    idLabel = user.role === "teacher" ? "Faculty ID" : "Student ID",
    idPlaceholder = user.role === "teacher" ? "FAC-1042" : "STU-1042";
  useEffect(() => {
    if (!localStorage.token) return;
    let current = true,
      objectUrl = "";
    Promise.all([api("/profile"), api("/settings")])
      .then(([p, s]) => current && setForm((f) => ({ ...f, ...p, ...s })))
      .catch(() => {});
    loadProfilePicture(user.id)
      .then((url) => {
        if (current) {
          objectUrl = url;
          setPhoto(url);
        } else if (url) URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [user.id]);
  function change(e) {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  }
  function choosePhoto(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      setMessage("Profile picture must be under 2 MB.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPhoto(reader.result);
      setPendingPhoto(reader.result);
      setMessage("New picture selected. Save changes to upload it.");
    };
    reader.readAsDataURL(file);
  }
  async function save() {
    if (!localStorage.token) {
      setMessage("Sign in with a real account to persist settings.");
      return;
    }
    try {
      await Promise.all([
        api("/profile", { method: "PUT", body: JSON.stringify(form) }),
        api("/settings", { method: "PUT", body: JSON.stringify(form) }),
        ...(pendingPhoto
          ? [
              api("/profile/picture", {
                method: "PUT",
                body: JSON.stringify({ image: pendingPhoto }),
              }),
            ]
          : []),
      ]);
      document.documentElement.dataset.theme = form.theme;
      document.documentElement.style.fontFamily =
        form.font === "serif" ? "Georgia, serif" : "";
      if (pendingPhoto) {
        setPendingPhoto("");
        window.dispatchEvent(new Event("profile-picture-updated"));
      }
      setMessage("Your profile and preferences were saved successfully.");
    } catch (e) {
      setMessage(e.message);
    }
  }
  return (
    <>
      <Title
        over="PREFERENCES"
        title="Settings"
        text="Manage your appearance, profile, account, and notifications."
      />
      <div className="settings-grid">
        <section className="panel settings-card">
          <h3>Profile</h3>
          <div className="photo-row">
            <label className="profile-photo">
              {photo ? (
                <img src={photo} alt={`${form.name} profile`} />
              ) : (
                <Camera />
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={choosePhoto}
              />
            </label>
            <div>
              <b>Profile picture</b>
              <p>PNG, JPG or WebP. Maximum 2 MB.</p>
            </div>
          </div>
          <label>
            Full name
            <input name="name" value={form.name} onChange={change} />
          </label>
          <label>
            Department
            <input
              name="department"
              value={form.department}
              onChange={change}
              placeholder="Computer Science"
            />
          </label>
          <label>
            {idLabel}
            <input
              name="identifier"
              value={form.identifier}
              onChange={change}
              placeholder={idPlaceholder}
            />
          </label>
        </section>
        <section className="panel settings-card">
          <h3>Appearance</h3>
          <label>
            Theme
            <select name="theme" value={form.theme} onChange={change}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System default</option>
            </select>
          </label>
          <label>
            Font
            <select name="font" value={form.font} onChange={change}>
              <option value="dm-sans">DM Sans</option>
              <option value="system">System</option>
              <option value="serif">Serif</option>
            </select>
          </label>
          <h3>Notifications</h3>
          {[
            ["emailNotifications", "Email notifications"],
            ["attendanceNotifications", "Attendance summaries"],
            ["invitationNotifications", "Class invitations"],
          ].map(([n, t]) => (
            <label className="toggle-row" key={n}>
              <span>
                <b>{t}</b>
                <small>Receive important {t.toLowerCase()}.</small>
              </span>
              <input
                type="checkbox"
                name={n}
                checked={form[n]}
                onChange={change}
              />
            </label>
          ))}
        </section>
      </div>
      <div className="settings-save">
        {message && <p>{message}</p>}
        <button className="primary" onClick={save}>
          <Check />
          Save changes
        </button>
      </div>
    </>
  );
}
function Modal({ data, close }) {
  const [done, setDone] = useState(false);
  return (
    <div className="backdrop">
      <section className="modal">
        <button className="x" onClick={close}>
          <X />
        </button>
        {done ? (
          <div className="success">
            <span>
              <Check />
            </span>
            <h2>
              {data.type === "invite"
                ? "Invitation ready"
                : "Classroom created"}
            </h2>
            <p>Connect SMTP to send real email invitations.</p>
            <button className="primary" onClick={close}>
              Done
            </button>
          </div>
        ) : (
          <>
            <small>
              {data.type === "invite" ? "ADD A STUDENT" : "NEW CLASSROOM"}
            </small>
            <h2>
              {data.type === "invite"
                ? `Invite to ${data.course.code}`
                : "Create a classroom"}
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setDone(true);
              }}
            >
              {data.type === "invite" ? (
                <label>
                  Student email
                  <input
                    type="email"
                    placeholder="student@university.edu"
                    required
                  />
                </label>
              ) : (
                <>
                  <label>
                    Class name
                    <input placeholder="Machine Learning" required />
                  </label>
                  <label>
                    Course code
                    <input placeholder="CS 405" required />
                  </label>
                </>
              )}
              <button className="primary wide">
                {data.type === "invite"
                  ? "Send invitation"
                  : "Create classroom"}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
export default function App() {
  useProjectTooltips();
  const initialQuery = new URLSearchParams(location.search);
  const requestedPage = initialQuery.get("page");
  const [user, setUser] = useState(null),
    [checkingSession, setCheckingSession] = useState(() =>
      Boolean(localStorage.token),
    ),
    [page, setPage] = useState(
      ["home", "classes", "attendance", "face", "people", "schedule", "reports", "admin", "settings"].includes(
        requestedPage,
      )
        ? requestedPage
        : "home",
    ),
    [classNavigation, setClassNavigation] = useState(() => ({
      classroomId: initialQuery.get("classroomId") || "",
      tab: initialQuery.get("tab") || "",
      assignmentId: initialQuery.get("assignmentId") || "",
      nonce: Date.now(),
    })),
    [nav, setNav] = useState(false),
    [modal, setModal] = useState(),
    [refresh, setRefresh] = useState(0),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const navigate = (event) => {
      const detail = event.detail || {};
      if (detail.page) setPage(detail.page);
      if (detail.classroomId)
        setClassNavigation({
          classroomId: detail.classroomId,
          tab: detail.tab || "stream",
          assignmentId: detail.assignmentId || "",
          nonce: Date.now(),
        });
    };
    window.addEventListener("classmark:navigate", navigate);
    return () => window.removeEventListener("classmark:navigate", navigate);
  }, []);
  useEffect(() => {
    if (!localStorage.token) return;
    api("/profile")
      .then((account) => {
        setUser(account);
        if (account.role === "admin") setPage("admin");
      })
      .catch(() => {
        delete localStorage.token;
        setUser(null);
      })
      .finally(() => setCheckingSession(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    const match = location.pathname.match(/^\/invite\/([^/]+)/);
    if (match)
      api(`/invitations/${match[1]}/accept`, { method: "POST" })
        .then(() => {
          setNotice(
            "Invitation accepted. The classroom was added to your account.",
          );
          setRefresh((x) => x + 1);
          history.replaceState({}, "", "/");
        })
        .catch((e) => setNotice(e.message));
  }, [user]);
  const titles = {
    home: "Overview",
    classes: "My classes",
    attendance: user?.role === "student" ? "QR check-in" : "Take attendance",
    face: "Face recognition",
    people: "People",
    schedule: "Schedule",
    reports: user?.role === "student" ? "My attendance" : "Reports",
    admin: "Administration",
    settings: "Settings",
  };
  if (checkingSession)
    return (
      <div className="session-loader">
        <Mark />
        <p>Restoring your session…</p>
      </div>
    );
  if (!user)
    return (
      <AuthView
        enter={(account) => {
          setUser(account);
          if (account.role === "admin") setPage("admin");
          setCheckingSession(false);
        }}
      />
    );
  if (!user.faceVerified)
    return (
      <div className="face-onboarding">
        <header className="onboarding-brand">
          <Mark />
          <b>Classmark</b>
          <button
            onClick={() => {
              delete localStorage.token;
              setUser(null);
            }}
          >
            Sign out
          </button>
        </header>
        <main>
          <div className="onboarding-callout">
            <ShieldCheck />
            <div>
              <small>REGISTRATION STEP 2 OF 2</small>
              <h1>Verify your identity to activate your account</h1>
              <p>
                Every account, including administrators, must complete one
                secure live-face enrollment before using the portal.
              </p>
            </div>
          </div>
          <FaceWorkspace
            user={user}
            Title={Title}
            onEnrolled={() => api("/profile").then(setUser)}
          />
        </main>
      </div>
    );
  if (user.role === "admin" && !user.adminFaceAuthenticated)
    return (
      <AdminLoginVerification
        user={user}
        onVerified={(account) => {
          setUser(account);
          setPage("admin");
        }}
        onSignOut={() => {
          delete localStorage.token;
          setUser(null);
        }}
      />
    );
  return (
    <div className="app">
      <Side
        {...{ page, setPage, user, open: nav, setOpen: setNav }}
        logout={() => {
          delete localStorage.token;
          setUser(null);
        }}
      />
      <div className="main">
        <Top
          title={titles[page]}
          open={() => setNav(true)}
          user={user}
          setPage={setPage}
        />
        {notice && (
          <div className="global-notice">
            {notice}
            <button onClick={() => setNotice("")}>
              <X />
            </button>
          </div>
        )}
        <main>
          {page === "home" && (
            <RealHome
              key={refresh}
              user={user}
              setPage={setPage}
              modal={() => setModal({ type: "create" })}
            />
          )}{" "}
          {page === "classes" && (
            <ClassesWorkspace
              user={user}
              openModal={setModal}
              refresh={refresh}
              navigation={classNavigation}
            />
          )}{" "}
          {page === "attendance" && <RoleAttendance user={user} />}{" "}
          {page === "face" && <FaceWorkspace user={user} Title={Title} />}{" "}
          {page === "people" && user.role === "teacher" && <PeopleWorkspace />}{" "}
          {page === "schedule" && <ScheduleWorkspace user={user} />}
          {page === "reports" && <ReportsWorkspace user={user} />}
          {page === "admin" && user.role === "admin" && <AdminWorkspace />}
          {page === "settings" && <SettingsView user={user} />}
        </main>
      </div>
      {modal && (
        <ClassActionModal
          data={modal}
          close={() => setModal()}
          onSaved={() => setRefresh((x) => x + 1)}
        />
      )}
    </div>
  );
}

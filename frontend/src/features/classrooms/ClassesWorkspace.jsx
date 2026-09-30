import { useEffect, useState } from "react";
import {
  Archive,
  BookOpen,
  Plus,
  RotateCcw,
  Trash2,
  Users,
} from "lucide-react";
import ClassroomPage from "./ClassroomPage.jsx";

const API = import.meta.env.VITE_API_URL || "/api";
async function api(path) {
  const response = await fetch(API + path, {
    headers: { Authorization: `Bearer ${localStorage.token}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data;
}

export default function ClassesWorkspace({
  user,
  openModal,
  refresh,
  navigation,
}) {
  const [rooms, setRooms] = useState([]);
  const [archivedRooms, setArchivedRooms] = useState([]);
  const [selectedId, setSelectedId] = useState(
    () => navigation?.classroomId || "",
  );
  const [selectedTab, setSelectedTab] = useState(() =>
    ["stream", "assignments", "people", "marks"].includes(navigation?.tab)
      ? navigation.tab
      : "stream",
  );
  const [error, setError] = useState("");
  const [code, setCode] = useState("");

  function load() {
    Promise.all([api("/classrooms"), api("/classrooms?archived=true")])
      .then(([active, archived]) => {
        setRooms(active);
        setArchivedRooms(archived);
      })
      .catch((issue) => setError(issue.message));
  }
  useEffect(load, [refresh]);
  useEffect(() => {
    if (!navigation?.classroomId) return;
    // Synchronize explicit notification/search navigation with this workspace.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(navigation.classroomId);
    setSelectedTab(
      ["stream", "assignments", "people", "marks"].includes(navigation.tab)
        ? navigation.tab
        : "stream",
    );
  }, [navigation?.classroomId, navigation?.nonce, navigation?.tab]);
  const selected = rooms.find((room) => room.id === selectedId);

  async function join(event) {
    event.preventDefault();
    try {
      const response = await fetch(API + "/classrooms/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.token}`,
        },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.message);
      setCode("");
      setError("");
      load();
    } catch (issue) {
      setError(issue.message);
    }
  }

  async function archivedAction(room, action) {
    const deleting = action === "delete";
    if (
      !window.confirm(
        deleting
          ? `Permanently delete “${room.name}”? This cannot be undone.`
          : `Restore “${room.name}” to active classrooms?`,
      )
    )
      return;
    try {
      const response = await fetch(
        `${API}/classrooms/${room.id}${deleting ? "" : "/restore"}`,
        {
          method: deleting ? "DELETE" : "PATCH",
          headers: { Authorization: `Bearer ${localStorage.token}` },
        },
      );
      const body = await response.json();
      if (!response.ok) throw Error(body.message);
      setError("");
      load();
    } catch (issue) {
      setError(issue.message);
    }
  }

  if (selected)
    return (
      <ClassroomPage
        key={`${selected.id}-${navigation?.nonce || "manual"}`}
        room={selected}
        user={user}
        onBack={() => {
          setSelectedId("");
          setSelectedTab("stream");
        }}
        onInvite={(course) => openModal({ type: "invite", course })}
        onChanged={load}
        initialTab={selectedTab}
        initialAssignmentId={navigation?.assignmentId}
      />
    );
  return (
    <>
      <div className="title">
        <div>
          <small>CLASSROOM MANAGEMENT</small>
          <h1>My classes</h1>
          <p>
            {user.role === "teacher"
              ? "Create classrooms and manage everything from one place."
              : "Join with a classroom code and access your coursework."}
          </p>
        </div>
        {user.role === "teacher" && (
          <button
            className="primary"
            onClick={() => openModal({ type: "create" })}
          >
            <Plus />
            New classroom
          </button>
        )}
      </div>
      {user.role === "student" && (
        <form className="panel join-class" onSubmit={join}>
          <div>
            <b>Join a classroom</b>
            <small>Enter the 10-character code given by your teacher.</small>
          </div>
          <input
            value={code}
            onChange={(event) =>
              setCode(
                event.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, 10),
              )
            }
            placeholder="AB12CD34EF"
            minLength="10"
            maxLength="10"
            required
          />
          <button className="primary">Join</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {rooms.length ? (
        <div className="cards">
          {rooms.map((room) => (
            <article key={room.id} onClick={() => { setSelectedTab("stream"); setSelectedId(room.id); }}>
              <header style={{ background: room.color }}>
                <b>{room.subject}</b>
                <BookOpen />
              </header>
              <div>
                <h3>{room.name}</h3>
                <p>{room.section || "No section"}</p>
                <span>
                  <Users />
                  {room.memberCount || 0} students
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
              ? "Create your first classroom to begin."
              : "Enter a valid classroom code above to join."}
          </p>
        </section>
      )}
      {archivedRooms.length > 0 && (
        <section className="archived-classrooms panel">
          <header>
            <Archive />
            <div>
              <h2>Archived classrooms</h2>
              <p>
                Hidden from active classes and available here for reference or
                restoration.
              </p>
            </div>
          </header>
          <div>
            {archivedRooms.map((room) => (
              <article key={room.id}>
                <span style={{ background: room.color }}>
                  <BookOpen />
                </span>
                <div>
                  <b>{room.name}</b>
                  <small>
                    {room.subject} · {room.section || "No section"}
                  </small>
                </div>
                {room.classroomRole === "owner" && (
                  <div className="archived-actions">
                    <button
                      className="outline"
                      onClick={() => archivedAction(room, "restore")}
                    >
                      <RotateCcw />
                      Restore
                    </button>
                    <button
                      className="danger"
                      onClick={() => archivedAction(room, "delete")}
                    >
                      <Trash2 />
                      Delete
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

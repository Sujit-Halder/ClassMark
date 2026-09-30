import { useCallback, useEffect, useState } from "react";
import { Check, Download, FileText, RotateCcw, X } from "lucide-react";
import "../../styles/feature-pages.css";

const API = import.meta.env.VITE_API_URL || "/api";
async function api(path, options = {}) {
  const response = await fetch(API + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.token}`,
      },
    }),
    data = await response.json();
  if (!response.ok) throw Error(data.message);
  return data;
}

export default function ReportsWorkspace({ user }) {
  const student = user.role === "student";
  const [rows, setRows] = useState([]),
    [rooms, setRooms] = useState([]),
    [corrections, setCorrections] = useState([]),
    [filters, setFilters] = useState({ classroomId: "", from: "", to: "" }),
    [message, setMessage] = useState("");
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
  const load = useCallback(
    () =>
      Promise.all([
        api(`${student ? "/attendance/mine" : "/reports/attendance"}?${query}`),
        api("/classrooms"),
        api("/attendance/corrections"),
      ])
        .then(([records, classrooms, correctionRows]) => {
          setRows(records);
          setRooms(classrooms);
          setCorrections(correctionRows);
        })
        .catch((error) => setMessage(error.message)),
    [query, student],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function download(format) {
    const response = await fetch(
      `${API}/reports/attendance.${format}?${query}`,
      { headers: { Authorization: `Bearer ${localStorage.token}` } },
    );
    if (!response.ok) return setMessage((await response.json()).message);
    const blob = await response.blob(),
      url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `classmark-attendance.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function requestCorrection(row) {
    const reason = prompt(
      "Explain why this absent result should be reviewed and marked present:",
    );
    if (!reason) return;
    try {
      const result = await api(`/attendance/${row.id}/corrections`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setMessage(result.message);
      load();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function decide(id, decision) {
    const note = prompt(`Optional note for ${decision}:`) || "";
    try {
      await api(`/attendance/corrections/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision, note }),
      });
      load();
    } catch (error) {
      setMessage(error.message);
    }
  }

  const pendingRecordIds = new Set(
    corrections
      .filter((item) => item.status === "pending")
      .map((item) => item.record_id),
  );

  return (
    <div className="feature-page">
      <div className="title">
        <div>
          <small>{student ? "MY ATTENDANCE" : "REPORTING"}</small>
          <h1>{student ? "Attendance history" : "Attendance reports"}</h1>
          <p>
            {student
              ? "Review your finalized results and dispute an absence when it is incorrect."
              : "Filter and export finalized attendance, then review student correction requests."}
          </p>
        </div>
        {!student && (
          <div className="title-actions">
            <button className="outline" onClick={() => download("csv")}><Download />CSV</button>
            <button className="primary" onClick={() => download("pdf")}><FileText />PDF</button>
          </div>
        )}
      </div>
      <div className="panel report-filters">
        <label>Classroom<select value={filters.classroomId} onChange={(event) => setFilters({ ...filters, classroomId: event.target.value })}><option value="">All classrooms</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
        <label>From<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label>To<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
      </div>
      {message && <p className="status-message">{message}</p>}
      <section className="panel data-table">
        <header><span>Date</span><span>Classroom</span><span>{student ? "Record" : "Student"}</span><span>Status</span><span>Verification</span><span /></header>
        {rows.map((row) => (
          <div key={row.id}>
            <span>{new Date(row.recordedAt).toLocaleString()}</span>
            <span><b>{row.classroomName}</b><small>{row.subject}</small></span>
            <span><b>{student ? "Finalized attendance" : row.studentName}</b><small>{student ? row.roomNumber || "Room not set" : row.identifier}</small></span>
            <span className={`result ${row.status}`}>{row.status}</span>
            <span>{row.method || "—"}</span>
            <span>{student && row.status === "absent" && <button className="outline compact" disabled={pendingRecordIds.has(row.id)} onClick={() => requestCorrection(row)}><RotateCcw />{pendingRecordIds.has(row.id) ? "Requested" : "Request review"}</button>}</span>
          </div>
        ))}
      </section>
      <section className="panel corrections">
        <h2>{student ? "My review requests" : user.role === "admin" ? "All student correction requests" : "Student correction requests"}</h2>
        {corrections.length ? corrections.map((item) => (
          <article key={item.id}>
            <div>
              <b>{item.studentName || "Student"} · {item.identifier || "No roll number"}</b>
              <small>{item.classroomName} · {item.subject} · {new Date(item.recordedAt).toLocaleString()}</small>
              <small>Room {item.roomNumber || "not set"} · Verification: {item.method || "none recorded"}{item.distanceMeters != null ? ` · ${Math.round(item.distanceMeters)} m from teacher` : ""}{item.locationAccuracy != null ? ` · GPS ±${Math.round(item.locationAccuracy)} m` : ""}</small>
              <small>Requested change: absent → present</small>
              <small>Request submitted: {new Date(item.requested_at).toLocaleString()}</small>
              {item.resolved_at && <small>Resolved: {new Date(item.resolved_at).toLocaleString()} by {item.resolvedByName || "classroom teacher"}{item.resolution_note ? ` · ${item.resolution_note}` : ""}</small>}
              <p>{item.reason}</p>
            </div>
            <em className={item.status}>{item.status}</em>
            {user.role === "teacher" && item.status === "pending" && <><button className="outline" onClick={() => decide(item.id, "rejected")}><X />Reject</button><button className="primary" onClick={() => decide(item.id, "approved")}><Check />Approve</button></>}
          </article>
        )) : <p className="muted">No correction requests.</p>}
      </section>
    </div>
  );
}

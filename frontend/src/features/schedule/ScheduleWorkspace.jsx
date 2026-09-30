import { useEffect, useState } from "react";
import { CalendarDays, Clock3, MapPin, Plus, Trash2 } from "lucide-react";
import "../../styles/feature-pages.css";
import "../../styles/schedule-timezone.css";

const API = import.meta.env.VITE_API_URL || "/api";
async function api(path, options = {}) { const response = await fetch(API + path, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.token}` } }); const data = await response.json(); if (!response.ok) throw Error(data.message); return data; }
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function ScheduleWorkspace({ user }) {
  const [items, setItems] = useState([]), [rooms, setRooms] = useState([]), [open, setOpen] = useState(false), [message, setMessage] = useState("");
  const deviceWeekday = new Date().getDay();
  const load = () => Promise.all([api("/schedules"), api("/classrooms")]).then(([schedules, classrooms]) => { setItems(schedules); setRooms(classrooms); }).catch((error) => setMessage(error.message));
  useEffect(() => { load(); }, []);
  async function create(event) { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { await api(`/classrooms/${values.classroomId}/schedules`, { method: "POST", body: JSON.stringify(values) }); setOpen(false); setMessage("Schedule added."); load(); } catch (error) { setMessage(error.message); } }
  async function remove(item) { if (!confirm(`Delete the ${days[item.weekday]} schedule for ${item.classroomName}?`)) return; await api(`/schedules/${item.id}`, { method: "DELETE" }); load(); }
  return <div className="feature-page"><div className="title"><div><small>TIMETABLE</small><h1>Class schedule</h1><p>Weekly planned classes across your active classrooms.</p></div>{user.role === "teacher" && <button className="primary" onClick={() => setOpen(!open)}><Plus />Add schedule</button>}</div>
    {open && <form className="panel feature-form" onSubmit={create}><label>Classroom<select name="classroomId" required>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name} · {room.subject}</option>)}</select></label><label>Weekday<select name="weekday">{days.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><label>Starts<input type="time" name="startTime" required /></label><label>Ends<input type="time" name="endTime" required /></label><label>Room<input name="roomNumber" placeholder="Room 302" /></label><button className="primary">Save schedule</button></form>}
    {message && <p className="status-message">{message}</p>}
    <section className="schedule-board">{days.map((day, weekday) => { const rows = items.filter((item) => item.weekday === weekday); return rows.length ? <article className={`panel schedule-day ${weekday === deviceWeekday ? "today" : ""}`} key={day}><header><CalendarDays /><h2>{day}</h2>{weekday === deviceWeekday && <small>Today</small>}</header>{rows.map((item) => <div key={item.id} style={{ "--course-color": item.color }}><i /><span><b>{item.classroomName}</b><small>{item.subject}</small></span><span><Clock3 />{item.start_time}–{item.end_time}</span><span><MapPin />{item.room_number || "Room not set"}</span>{user.role === "teacher" && <button onClick={() => remove(item)} aria-label="Delete schedule"><Trash2 /></button>}</div>)}</article> : null; })}</section>
    {!items.length && <section className="panel empty-state"><CalendarDays /><h3>No scheduled classes</h3><p>{user.role === "teacher" ? "Add a weekly time to make the timetable and Today count useful." : "Your teachers have not published a timetable yet."}</p></section>}
  </div>;
}

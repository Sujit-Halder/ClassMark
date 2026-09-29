import { useEffect, useMemo, useState } from "react";
import { GraduationCap, Search, Users } from "lucide-react";
import "../../styles/people.css";

const API = import.meta.env.VITE_API_URL || "/api";

export default function PeopleWorkspace() {
  const [data, setData] = useState({ classrooms: [], people: [] });
  const [query, setQuery] = useState("");
  const [classroom, setClassroom] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API}/people`, {
      headers: { Authorization: `Bearer ${localStorage.token}` },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw Error(body.message);
        return body;
      })
      .then(setData)
      .catch((issue) => setError(issue.message));
  }, []);

  const people = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.people.filter((person) => {
      const matchesSearch =
        !needle ||
        [person.name, person.email, person.identifier, person.department]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      const matchesClass =
        !classroom ||
        String(person.classroomNames || "")
          .split(",")
          .includes(classroom);
      return matchesSearch && matchesClass;
    });
  }, [data.people, query, classroom]);

  const teachers = people.filter((person) => person.role === "teacher");
  const students = people.filter((person) => person.role === "student");
  const group = (title, icon, rows) => (
    <section className="panel people-group">
      <header>
        {icon}
        <div>
          <h2>{title}</h2>
          <small>{rows.length} people</small>
        </div>
      </header>
      {rows.length ? (
        rows.map((person) => (
          <article key={person.id}>
            <span>
              {person.name
                .split(" ")
                .map((part) => part[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div>
              <b>{person.name}</b>
              <small>{person.email}</small>
            </div>
            <div>
              <b>{person.identifier || "No ID"}</b>
              <small>{person.department || "No department"}</small>
            </div>
            <div>
              <b>{person.classroomCount} classes</b>
              <small>{person.classroomNames || "—"}</small>
            </div>
          </article>
        ))
      ) : (
        <p className="muted">No matching {title.toLowerCase()}.</p>
      )}
    </section>
  );

  return (
    <div className="people-workspace">
      <div className="title">
        <div>
          <small>DIRECTORY</small>
          <h1>People</h1>
          <p>Teachers and students across all classrooms you manage.</p>
        </div>
      </div>
      <div className="people-filters">
        <label>
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email or ID"
          />
        </label>
        <select
          value={classroom}
          onChange={(event) => setClassroom(event.target.value)}
        >
          <option value="">All classrooms</option>
          {data.classrooms.map((room) => (
            <option key={room.id} value={room.name}>
              {room.name} · {room.subject}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {group("Teachers", <Users />, teachers)}
      {group("Students", <GraduationCap />, students)}
    </div>
  );
}

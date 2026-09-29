import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  BookOpen,
  Calendar,
  Check,
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  Link,
  Lock,
  Mail,
  Megaphone,
  Pencil,
  Plus,
  Send,
  Trash2,
  Unlock,
  UserMinus,
  Users,
} from "lucide-react";
import "../../styles/classroom.css";
import "../../styles/assignment-controls.css";

const API = import.meta.env.VITE_API_URL || "/api";
async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.token}`,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data;
}
const initials = (name) =>
  name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const localDateTime = (value) =>
  value
    ? new Date(
        new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";

export default function ClassroomPage({
  room,
  user,
  onBack,
  onInvite,
  onChanged,
  initialTab = "stream",
  initialAssignmentId = "",
}) {
  const [tab, setTab] = useState(initialTab);
  const [posts, setPosts] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [members, setMembers] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [marks, setMarks] = useState([]);
  const [submissions, setSubmissions] = useState({});
  const [composer, setComposer] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState(false);
  const [resourceForm, setResourceForm] = useState(false);
  const [error, setError] = useState("");
  const [confirmAction, setConfirmAction] = useState(null);
  const [editingAssignment, setEditingAssignment] = useState(null);
  const [assignmentToDelete, setAssignmentToDelete] = useState(null);
  const [editingClassroom, setEditingClassroom] = useState(false);
  const [classroomDetails, setClassroomDetails] = useState(room);
  const [locked, setLocked] = useState(Boolean(room.is_locked));
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [postRows, assignmentRows, memberRows, teacherRows, markRows] =
        await Promise.all([
          api(`/classrooms/${room.id}/posts`),
          api(`/classrooms/${room.id}/assignments`),
          api(`/classrooms/${room.id}/members`),
          api(`/classrooms/${room.id}/teachers`),
          api(`/classrooms/${room.id}/marks`),
        ]);
      setPosts(postRows);
      setAssignments(assignmentRows);
      setMembers(memberRows);
      setTeachers(teacherRows);
      setMarks(markRows);
    } catch (err) {
      setError(err.message);
    }
  }, [room.id]);

  useEffect(() => {
    // Initial data synchronization for the selected classroom.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  useEffect(() => {
    if (initialAssignmentId)
      setTimeout(
        () =>
          document
            .getElementById(`assignment-${initialAssignmentId}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" }),
        150,
      );
  }, [initialAssignmentId]);

  async function createPost(event) {
    event.preventDefault();
    try {
      await api(`/classrooms/${room.id}/posts`, {
        method: "POST",
        body: JSON.stringify({
          content: new FormData(event.currentTarget).get("content"),
        }),
      });
      setComposer(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function createAssignment(event) {
    event.preventDefault();
    try {
      await api(`/classrooms/${room.id}/assignments`, {
        method: "POST",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget)),
        ),
      });
      setAssignmentForm(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function updateAssignment(event, id) {
    event.preventDefault();
    try {
      await api(`/assignments/${id}`, {
        method: "PUT",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget)),
        ),
      });
      setEditingAssignment(null);
      setError("");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function deleteAssignment() {
    if (!assignmentToDelete) return;
    try {
      await api(`/assignments/${assignmentToDelete.id}`, { method: "DELETE" });
      setAssignmentToDelete(null);
      setEditingAssignment(null);
      setError("");
      await load();
    } catch (err) {
      setError(err.message);
      setAssignmentToDelete(null);
    }
  }
  async function submitWork(event, id) {
    event.preventDefault();
    try {
      await api(`/assignments/${id}/submit`, {
        method: "POST",
        body: JSON.stringify({
          content: new FormData(event.currentTarget).get("content"),
        }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function review(id) {
    if (submissions[id]) {
      setSubmissions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const rows = await api(`/assignments/${id}/submissions`);
      setSubmissions((current) => ({ ...current, [id]: rows }));
    } catch (err) {
      setError(err.message);
    }
  }
  async function shareResource(event) {
    event.preventDefault();
    try {
      await api(`/classrooms/${room.id}/resources`, {
        method: "POST",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget)),
        ),
      });
      setResourceForm(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  function openAssignment(id) {
    setTab("assignments");
    setTimeout(
      () =>
        document
          .getElementById(`assignment-${id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      80,
    );
  }
  async function grade(event, assignmentId, studentId) {
    event.preventDefault();
    try {
      await api(`/assignments/${assignmentId}/submissions/${studentId}/grade`, {
        method: "PUT",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget)),
        ),
      });
      await review(assignmentId);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function removeStudent(id) {
    if (!confirm("Remove this student from the classroom?")) return;
    await api(`/classrooms/${room.id}/members/${id}`, { method: "DELETE" });
    await load();
    onChanged?.();
  }
  async function leaveClass() {
    if (
      !confirm(
        "Leave this classroom? You will need another invitation to rejoin.",
      )
    )
      return;
    await api(`/classrooms/${room.id}/members/me`, { method: "DELETE" });
    onChanged?.();
    onBack();
  }
  async function ownerAction(action) {
    const deleting = action === "delete";
    try {
      await api(`/classrooms/${room.id}${deleting ? "" : "/archive"}`, {
        method: deleting ? "DELETE" : "PATCH",
      });
      onChanged?.();
      onBack();
    } catch (err) {
      setError(err.message);
    }
  }
  async function toggleLock() {
    try {
      const result = await api(`/classrooms/${room.id}/lock`, {
        method: "PATCH",
        body: JSON.stringify({ locked: !locked }),
      });
      setLocked(result.locked);
    } catch (err) {
      setError(err.message);
    }
  }
  async function updateClassroom(event) {
    event.preventDefault();
    try {
      const updated = await api(`/classrooms/${room.id}`, {
        method: "PUT",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget)),
        ),
      });
      setClassroomDetails((current) => ({ ...current, ...updated }));
      setEditingClassroom(false);
      setError("");
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }
  async function copyCode() {
    await navigator.clipboard.writeText(room.class_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const tabs = [
    ["stream", Megaphone, "Stream"],
    ["assignments", ClipboardList, "Assignments"],
    ["people", Users, "People"],
    ["marks", Check, "Marks"],
  ];
  return (
    <div className="classroom-page">
      <button className="class-back" onClick={onBack}>
        <ArrowLeft />
        All classes
      </button>
      <header
        className="class-hero"
        style={{ "--class-color": classroomDetails.color || "#6556e8" }}
      >
        <div>
          <span>{classroomDetails.subject}</span>
          <h1>{classroomDetails.name}</h1>
          <p>
            {classroomDetails.section || "No section"} · {teachers.length}{" "}
            teacher{teachers.length === 1 ? "" : "s"} · {members.length}{" "}
            students
          </p>
          {room.classroomRole === "owner" && (
            <div className="owner-actions">
              <button onClick={() => setEditingClassroom(!editingClassroom)}>
                <Pencil />
                Edit classroom
              </button>
              <button onClick={toggleLock}>
                {locked ? (
                  <>
                    <Unlock />
                    Unlock joining
                  </>
                ) : (
                  <>
                    <Lock />
                    Lock joining
                  </>
                )}
              </button>
              <button onClick={() => setConfirmAction("archive")}>
                <Archive />
                Archive
              </button>
              <button onClick={() => setConfirmAction("delete")}>
                <Trash2 />
                Delete
              </button>
            </div>
          )}
        </div>
        <BookOpen />
      </header>
      {editingClassroom && room.classroomRole === "owner" && (
        <form
          className="class-panel assignment-form classroom-edit-form"
          onSubmit={updateClassroom}
        >
          <h3>Edit classroom</h3>
          <label>
            Class name
            <input name="name" defaultValue={classroomDetails.name} required />
          </label>
          <label>
            Subject / course code
            <input
              name="subject"
              defaultValue={classroomDetails.subject}
              required
            />
          </label>
          <div>
            <label>
              Section
              <input
                name="section"
                defaultValue={classroomDetails.section || ""}
              />
            </label>
            <label>
              Color
              <input
                name="color"
                type="color"
                defaultValue={classroomDetails.color || "#6556e8"}
              />
            </label>
          </div>
          <footer>
            <button
              type="button"
              className="outline"
              onClick={() => setEditingClassroom(false)}
            >
              Cancel
            </button>
            <button className="primary">Save classroom</button>
          </footer>
        </form>
      )}
      <nav className="class-tabs">
        {tabs.map(([id, Icon, label]) => (
          <button
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            key={id}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}

      {tab === "stream" && (
        <div className="class-layout">
          <main>
            {user.role === "teacher" && !composer && !resourceForm && (
              <div className="stream-actions">
                <button
                  className="start-post"
                  onClick={() => setComposer(true)}
                >
                  <span className="avatar">{initials(user.name)}</span>Announce
                  something to your class…
                </button>
                <button
                  className="outline"
                  onClick={() => setResourceForm(true)}
                >
                  <Link />
                  Share resource
                </button>
              </div>
            )}
            {composer && (
              <form className="class-panel post-composer" onSubmit={createPost}>
                <h3>Class announcement</h3>
                <textarea
                  name="content"
                  placeholder="Share an update, reminder, or resource…"
                  required
                  autoFocus
                />
                <footer>
                  <button
                    type="button"
                    className="outline"
                    onClick={() => setComposer(false)}
                  >
                    Cancel
                  </button>
                  <button className="primary">
                    <Send />
                    Post
                  </button>
                </footer>
              </form>
            )}
            {resourceForm && (
              <form
                className="class-panel assignment-form"
                onSubmit={shareResource}
              >
                <h3>Share a resource</h3>
                <label>
                  Title
                  <input name="title" required />
                </label>
                <label>
                  Link
                  <input
                    name="url"
                    type="url"
                    placeholder="https://…"
                    required
                  />
                </label>
                <label>
                  Description
                  <textarea name="description" />
                </label>
                <footer>
                  <button
                    type="button"
                    className="outline"
                    onClick={() => setResourceForm(false)}
                  >
                    Cancel
                  </button>
                  <button className="primary">
                    <Send />
                    Share
                  </button>
                </footer>
              </form>
            )}
            {posts.length ? (
              posts.map((post) => (
                <article
                  className={`class-panel stream-post ${post.postType !== "announcement" ? "activity-post" : ""}`}
                  key={post.id}
                  onClick={() =>
                    post.postType === "assignment" &&
                    openAssignment(post.referenceId)
                  }
                >
                  <header>
                    <span className="avatar">
                      {post.postType === "assignment" ? (
                        <ClipboardList />
                      ) : post.postType === "resource" ? (
                        <Link />
                      ) : (
                        initials(post.authorName)
                      )}
                    </span>
                    <div>
                      <b>
                        {post.postType === "assignment"
                          ? "Assignment posted"
                          : post.postType === "resource"
                            ? "Resource shared"
                            : post.authorName}
                      </b>
                      <small>
                        {post.authorName} ·{" "}
                        {new Date(post.createdAt).toLocaleString()}
                      </small>
                    </div>
                  </header>
                  <p>{post.content}</p>
                  {post.postType === "assignment" && (
                    <button className="activity-link">Open assignment →</button>
                  )}
                  {post.postType === "resource" && (
                    <a
                      className="activity-link"
                      href={post.resourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {post.resourceTitle}
                      <ExternalLink />
                    </a>
                  )}
                </article>
              ))
            ) : (
              <Empty
                Icon={Megaphone}
                title="The stream is quiet"
                text={
                  user.role === "teacher"
                    ? "Post an announcement to welcome your class."
                    : "Announcements will appear here."
                }
              />
            )}
          </main>
          <aside>
            <section className="class-panel">
              <h3>Upcoming</h3>
              <p>
                {assignments.length
                  ? `${assignments.length} assignment${assignments.length === 1 ? "" : "s"} posted.`
                  : "No work due soon."}
              </p>
              <button onClick={() => setTab("assignments")}>
                View assignments
              </button>
            </section>
            <section className="class-panel class-code">
              <small>CLASS DETAILS</small>
              <b>{room.subject}</b>
              <span>{room.section || "No section"}</span>
            </section>
          </aside>
        </div>
      )}

      {tab === "assignments" && (
        <section>
          {user.role === "teacher" && (
            <div className="tab-actions">
              <button
                className="primary"
                onClick={() => setAssignmentForm(!assignmentForm)}
              >
                <Plus />
                Create assignment
              </button>
            </div>
          )}
          {assignmentForm && (
            <form
              className="class-panel assignment-form"
              onSubmit={createAssignment}
            >
              <h3>New assignment</h3>
              <label>
                Title
                <input name="title" required />
              </label>
              <label>
                Instructions
                <textarea name="description" />
              </label>
              <div>
                <label>
                  Due date
                  <input name="dueAt" type="datetime-local" />
                </label>
                <label>
                  Points
                  <input
                    name="points"
                    type="number"
                    min="1"
                    defaultValue="100"
                  />
                </label>
              </div>
              <footer>
                <button
                  type="button"
                  className="outline"
                  onClick={() => setAssignmentForm(false)}
                >
                  Cancel
                </button>
                <button className="primary">Assign</button>
              </footer>
            </form>
          )}
          {assignments.length ? (
            <div className="assignment-list">
              {assignments.map((assignment) => (
                <article
                  id={`assignment-${assignment.id}`}
                  className="class-panel assignment"
                  key={assignment.id}
                >
                  <span>
                    <FileText />
                  </span>
                  <div className="assignment-main">
                    <header>
                      <div>
                        <h3>{assignment.title}</h3>
                        <p>
                          {assignment.description ||
                            "No instructions provided."}
                        </p>
                      </div>
                      <div className="assignment-heading-actions">
                        <b>{assignment.points} pts</b>
                        {user.role === "teacher" && (
                          <div className="assignment-tools">
                            <button
                              className="outline"
                              title="Edit assignment"
                              onClick={() =>
                                setEditingAssignment(
                                  editingAssignment?.id === assignment.id
                                    ? null
                                    : assignment,
                                )
                              }
                            >
                              <Pencil />
                              Edit
                            </button>
                            <button
                              className="danger"
                              title="Delete assignment"
                              onClick={() => setAssignmentToDelete(assignment)}
                            >
                              <Trash2 />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </header>
                    <small>
                      <Calendar />
                      {assignment.due_at
                        ? `Due ${new Date(assignment.due_at).toLocaleString()}`
                        : "No due date"}
                    </small>
                    {editingAssignment?.id === assignment.id && (
                      <form
                        className="edit-assignment-form assignment-form"
                        onSubmit={(event) =>
                          updateAssignment(event, assignment.id)
                        }
                      >
                        <h3>Edit assignment</h3>
                        <label>
                          Title
                          <input
                            name="title"
                            defaultValue={assignment.title}
                            required
                          />
                        </label>
                        <label>
                          Instructions
                          <textarea
                            name="description"
                            defaultValue={assignment.description || ""}
                          />
                        </label>
                        <div>
                          <label>
                            Due date
                            <input
                              name="dueAt"
                              type="datetime-local"
                              defaultValue={localDateTime(assignment.due_at)}
                            />
                          </label>
                          <label>
                            Points
                            <input
                              name="points"
                              type="number"
                              min="1"
                              step="0.01"
                              defaultValue={assignment.points}
                              required
                            />
                          </label>
                        </div>
                        <small>
                          Points cannot be lower than the highest grade already
                          awarded.
                        </small>
                        <footer>
                          <button
                            type="button"
                            className="outline"
                            onClick={() => setEditingAssignment(null)}
                          >
                            Cancel
                          </button>
                          <button className="primary">Save changes</button>
                        </footer>
                      </form>
                    )}
                    {user.role === "student" &&
                      (assignment.isExpired ? (
                        <div className="deadline-closed">
                          <Lock />
                          <div>
                            <b>Submission closed</b>
                            <p>
                              The deadline has passed. A missing submission is
                              recorded as 0.
                            </p>
                            {assignment.grade != null && (
                              <span>
                                Mark: {assignment.grade}/{assignment.points}
                                {assignment.feedback &&
                                  ` · ${assignment.feedback}`}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <form
                          onSubmit={(event) => submitWork(event, assignment.id)}
                        >
                          <textarea
                            name="content"
                            defaultValue={assignment.submissionContent || ""}
                            placeholder="Write your response or submission link…"
                            required
                          />
                          <button className="primary">
                            {assignment.submissionId
                              ? "Update submission"
                              : "Submit work"}
                          </button>
                          {assignment.grade != null && (
                            <p className="grade-pill">
                              Graded: {assignment.grade}/{assignment.points}{" "}
                              {assignment.feedback &&
                                `· ${assignment.feedback}`}
                            </p>
                          )}
                        </form>
                      ))}
                    {user.role === "teacher" && (
                      <>
                        <button
                          className="outline review-btn"
                          onClick={() => review(assignment.id)}
                        >
                          {submissions[assignment.id]
                            ? "Close submissions"
                            : "Review submissions"}
                        </button>
                        {submissions[assignment.id]?.map((submission) => (
                          <form
                            className="submission-row"
                            key={submission.student_id}
                            onSubmit={(event) =>
                              grade(event, assignment.id, submission.student_id)
                            }
                          >
                            <div>
                              <b>{submission.studentName}</b>
                              <p>{submission.content}</p>
                            </div>
                            <input
                              name="grade"
                              aria-label={`Grade out of ${assignment.points}`}
                              title={`Maximum ${assignment.points} points`}
                              type="number"
                              min="0"
                              max={assignment.points}
                              step="0.01"
                              defaultValue={submission.grade ?? ""}
                              required
                            />
                            <input
                              name="feedback"
                              defaultValue={submission.feedback || ""}
                              placeholder="Feedback"
                            />
                            <button>Save</button>
                          </form>
                        ))}
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              Icon={ClipboardList}
              title="No assignments yet"
              text={
                user.role === "teacher"
                  ? "Create the first assignment."
                  : "Assignments will appear here."
              }
            />
          )}
        </section>
      )}

      {tab === "people" && (
        <section className="class-panel people-panel">
          <div className="section-title">
            <div>
              <small>CLASS ROSTER</small>
              <h2>People</h2>
            </div>
            {user.role === "teacher" && (
              <button className="primary" onClick={() => onInvite(room)}>
                <Mail />
                Invite person
              </button>
            )}
          </div>
          {user.role === "teacher" && (
            <div className="class-code-banner">
              <span>Student classroom code · {locked ? "Locked" : "Open"}</span>
              <div>
                <b>{room.class_code}</b>
                <button onClick={copyCode}>
                  <Copy />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <small>
                {locked
                  ? "Code joining is disabled. Students need an invitation link."
                  : "Students may use this 10-character code to join."}
              </small>
            </div>
          )}
          <h3>
            Teachers <span>{teachers.length}</span>
          </h3>
          {teachers.map((teacher) => (
            <div className="member-row" key={teacher.id}>
              <span className="avatar teacher">{initials(teacher.name)}</span>
              <div>
                <b>
                  {teacher.name}{" "}
                  {teacher.classroomRole === "owner" && <em>Owner</em>}
                </b>
                <small>
                  {teacher.email} ·{" "}
                  {teacher.classroomRole === "owner"
                    ? "Can archive and delete"
                    : "Co-teacher"}
                </small>
              </div>
            </div>
          ))}
          <h3>
            Students <span>{members.length}</span>
          </h3>
          {members.map((member) => (
            <div className="member-row" key={member.id}>
              <span className="avatar">{initials(member.name)}</span>
              <div>
                <b>{member.name}</b>
                <small>
                  {member.email} · {member.identifier || "No ID provided"}
                </small>
              </div>
              {user.role === "teacher" && (
                <button
                  className="danger small"
                  onClick={() => removeStudent(member.id)}
                >
                  <UserMinus />
                  Remove
                </button>
              )}
            </div>
          ))}
          {!members.length && (
            <p className="muted">No students have joined yet.</p>
          )}
          {user.role === "student" && (
            <button className="danger leave-button" onClick={leaveClass}>
              Leave classroom
            </button>
          )}
        </section>
      )}

      {tab === "marks" && (
        <section className="class-panel marks-panel">
          <div className="section-title">
            <div>
              <small>PERFORMANCE</small>
              <h2>{user.role === "teacher" ? "Class marks" : "My marks"}</h2>
            </div>
          </div>
          {marks.length ? (
            <div className="marks-table">
              <div className="marks-head">
                <span>Student</span>
                <span>Attendance</span>
                <span>Assignment average</span>
              </div>
              {marks.map((mark) => {
                const rate = mark.attendanceTotal
                  ? Math.round(
                      (mark.attendancePresent / mark.attendanceTotal) * 100,
                    )
                  : null;
                return (
                  <div className="marks-row" key={mark.id}>
                    <span>
                      <b>{mark.name}</b>
                      <small>{mark.identifier || mark.email}</small>
                    </span>
                    <span>
                      {rate == null ? "—" : `${rate}%`}
                      <small>
                        {mark.attendancePresent}/{mark.attendanceTotal} present
                      </small>
                    </span>
                    <span>
                      {mark.assignmentAverage == null
                        ? "—"
                        : `${mark.assignmentAverage}%`}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              Icon={Check}
              title="No marks yet"
              text="Marks appear after grading or finalized attendance."
            />
          )}
        </section>
      )}
      {confirmAction && (
        <div className="confirm-backdrop">
          <section className="confirm-dialog">
            <span>
              <AlertTriangle />
            </span>
            <h2>
              {confirmAction === "delete"
                ? "Delete classroom permanently?"
                : "Archive this classroom?"}
            </h2>
            <p>
              {confirmAction === "delete"
                ? "This permanently removes the classroom, posts, assignments, submissions, attendance, and memberships. This action cannot be undone."
                : "The classroom will disappear from active lists and code joining will stop. Its records remain stored."}
            </p>
            <div>
              <button
                className="outline"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => ownerAction(confirmAction)}
              >
                {confirmAction === "delete"
                  ? "Delete permanently"
                  : "Archive classroom"}
              </button>
            </div>
          </section>
        </div>
      )}
      {assignmentToDelete && (
        <div className="confirm-backdrop">
          <section className="confirm-dialog">
            <span>
              <AlertTriangle />
            </span>
            <h2>Delete this assignment?</h2>
            <p>
              “{assignmentToDelete.title}” and all of its student submissions
              and grades will be permanently deleted. This cannot be undone.
            </p>
            <div>
              <button
                className="outline"
                onClick={() => setAssignmentToDelete(null)}
              >
                Cancel
              </button>
              <button className="danger" onClick={deleteAssignment}>
                Delete assignment
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Empty({ Icon, title, text }) {
  return (
    <div className="class-panel class-empty">
      <Icon />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

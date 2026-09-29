import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import "../../styles/face-workspace.css";

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

function LivenessCheck({ enrollment, onComplete, onCancel }) {
  const [Detector, setDetector] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    Promise.all([
      import("aws-amplify"),
      import("@aws-amplify/ui-react-liveness"),
      import("@aws-amplify/ui-react/styles.css"),
    ])
      .then(([amplify, liveness]) => {
        amplify.Amplify.configure({
          Auth: {
            Cognito: {
              identityPoolId: enrollment.identityPoolId,
              allowGuestAccess: true,
            },
          },
        });
        if (mounted) setDetector(() => liveness.FaceLivenessDetector);
      })
      .catch((err) => mounted && setError(err.message));
    return () => {
      mounted = false;
    };
  }, [enrollment.identityPoolId]);
  function detectorError(event) {
    const detail = event?.error?.message || event?.message || event?.name;
    if (/permission|camera/i.test(detail || ""))
      setError(
        "Camera access failed. Open this page in Chrome or Safari over HTTPS and allow camera permission.",
      );
    else if (/credential|access.?denied|unauthorized/i.test(detail || ""))
      setError(
        "AWS could not authorize this check. The administrator must verify the Cognito identity pool policy.",
      );
    else
      setError(
        detail ||
          "The live camera check was interrupted. Keep this page open and try again on a stable connection.",
      );
  }
  return (
    <section className="panel liveness-panel">
      <div className="biometric-heading">
        <div>
          <small>LIVE ENROLLMENT</small>
          <h2>Quick live face check</h2>
          <p>
            Use the front camera, keep your face fully visible, then move closer
            when the oval asks you to. No flashing-light sequence is used.
          </p>
        </div>
        <button className="outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="liveness-tips">
        <span>
          <Check />
          Face a window or soft room light
        </span>
        <span>
          <Check />
          Remove sunglasses, mask, hat, and hand obstructions
        </span>
        <span>
          <Check />
          Keep the phone at eye level and the camera lens clean
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      {Detector ? (
        <Detector
          sessionId={enrollment.sessionId}
          region={enrollment.region}
          onAnalysisComplete={onComplete}
          onError={detectorError}
        />
      ) : (
        <div className="liveness-loading">
          <RefreshCw />
          <p>Loading secure AWS liveness check…</p>
        </div>
      )}
    </section>
  );
}

function RecognitionCamera({ sessions }) {
  const video = useRef(null),
    canvas = useRef(null),
    stream = useRef(null);
  const [sessionId, setSessionId] = useState(sessions[0]?.id || "");
  const [active, setActive] = useState(false),
    [photo, setPhoto] = useState(""),
    [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null),
    [message, setMessage] = useState(""),
    [events, setEvents] = useState([]);
  async function loadEvents(id = sessionId) {
    if (!id) return setEvents([]);
    try {
      setEvents(await api(`/sessions/${id}/face-events`));
    } catch (err) {
      setMessage(err.message);
    }
  }
  useEffect(() => {
    let current = true;
    if (!sessionId) return;
    api(`/sessions/${sessionId}/face-events`)
      .then((rows) => current && setEvents(rows))
      .catch((err) => current && setMessage(err.message));
    return () => {
      current = false;
    };
  }, [sessionId]);
  useEffect(
    () => () => stream.current?.getTracks().forEach((track) => track.stop()),
    [],
  );
  async function start() {
    setMessage("");
    setResult(null);
    setPhoto("");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      video.current.srcObject = stream.current;
      setActive(true);
    } catch {
      setMessage(
        "Camera permission is required. Use HTTPS and allow camera access.",
      );
    }
  }
  function capture() {
    const source = video.current,
      c = canvas.current,
      maxWidth = 1280,
      scale = Math.min(1, maxWidth / source.videoWidth);
    c.width = Math.round(source.videoWidth * scale);
    c.height = Math.round(source.videoHeight * scale);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    setPhoto(c.toDataURL("image/jpeg", 0.78));
    stream.current?.getTracks().forEach((track) => track.stop());
    setActive(false);
  }
  async function identify() {
    if (!sessionId)
      return setMessage("Generate an attendance QR session first.");
    setBusy(true);
    setMessage("");
    try {
      const response = await api("/faces/identify", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          image: photo,
          cameraLabel: "mobile-entrance-camera",
        }),
      });
      setResult(response);
      setMessage(response.message);
      await loadEvents();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="recognition-layout">
      <section className="panel recognition-camera">
        <div className="biometric-heading">
          <div>
            <small>TEACHER CAMERA</small>
            <h2>Entrance recognition</h2>
            <p>Capture one clearly visible student at a time.</p>
          </div>
        </div>
        <label>
          Active attendance session
          <select
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">Select active session</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.subject} — {session.classroomName} ·{" "}
                {session.roomNumber}
              </option>
            ))}
          </select>
        </label>
        {!sessions.length && (
          <p className="warning-box">
            <AlertTriangle />
            Generate a QR attendance session first. Face events are tied to that
            same session.
          </p>
        )}
        <div className="face-camera-frame">
          {photo ? (
            <img src={photo} alt="Captured face" />
          ) : (
            <video ref={video} autoPlay playsInline muted />
          )}
          <canvas ref={canvas} />
          {!active && !photo && (
            <span>
              <Camera />
              <b>Rear camera is off</b>
            </span>
          )}
        </div>
        <div className="camera-actions">
          {!active && !photo && (
            <button className="primary" onClick={start}>
              <Camera />
              Open rear camera
            </button>
          )}
          {active && (
            <button className="primary" onClick={capture}>
              <ScanFace />
              Capture face
            </button>
          )}
          {photo && (
            <>
              <button className="outline" onClick={start}>
                Retake
              </button>
              <button
                className="primary"
                onClick={identify}
                disabled={busy || !sessionId}
              >
                <ScanFace />
                {busy ? "Identifying…" : "Identify student"}
              </button>
            </>
          )}
        </div>
        {message && (
          <p className={`recognition-message ${result?.status || ""}`}>
            {message}
          </p>
        )}
        {result?.user && (
          <div className="recognized-user">
            <Check />
            <div>
              <b>{result.user.name}</b>
              <span>
                {result.user.identifier || "No student ID"} ·{" "}
                {result.attendanceDecision === "present"
                  ? "Attendance complete"
                  : "Waiting for QR verification"}
              </span>
            </div>
          </div>
        )}
      </section>
      <section className="panel recognition-events">
        <div className="biometric-heading">
          <div>
            <small>RECENT EVENTS</small>
            <h2>Recognition log</h2>
          </div>
          <button className="outline" onClick={() => loadEvents()}>
            <RefreshCw />
            Refresh
          </button>
        </div>
        {events.length ? (
          events.map((event) => (
            <article key={event.id} className={`face-event ${event.status}`}>
              <span>
                <Users />
              </span>
              <div>
                <b>{event.userName || event.status}</b>
                <small>{event.identifier || event.reason}</small>
                <time>{new Date(event.capturedAt).toLocaleString()}</time>
              </div>
              {event.confidence != null && (
                <em>{event.confidence.toFixed(1)}%</em>
              )}
            </article>
          ))
        ) : (
          <p className="muted">Recognition events will appear here.</p>
        )}
      </section>
    </div>
  );
}

export default function FaceWorkspace({ user, Title, onEnrolled }) {
  const [status, setStatus] = useState(null),
    [consent, setConsent] = useState(false),
    [enrollment, setEnrollment] = useState(null);
  const [sessions, setSessions] = useState([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function load() {
    try {
      const current = await api("/faces/status");
      setStatus(current);
      if (user.role === "teacher")
        setSessions(await api("/faces/active-sessions"));
    } catch (err) {
      setMessage(err.message);
    }
  }
  useEffect(() => {
    let current = true;
    api("/faces/status")
      .then(async (faceStatus) => {
        if (!current) return;
        setStatus(faceStatus);
        if (user.role === "teacher") {
          const rows = await api("/faces/active-sessions");
          if (current) setSessions(rows);
        }
      })
      .catch((err) => current && setMessage(err.message));
    return () => {
      current = false;
    };
  }, [user.role]);
  async function begin() {
    setBusy(true);
    setMessage("");
    try {
      setEnrollment(
        await api("/faces/liveness/session", {
          method: "POST",
          body: JSON.stringify({ consent }),
        }),
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    setBusy(true);
    setMessage("Processing your liveness result and creating the face vector…");
    try {
      const result = await api("/faces/liveness/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId: enrollment.sessionId }),
      });
      setMessage(result.message);
      setEnrollment(null);
      await load();
      onEnrolled?.();
    } catch (err) {
      setMessage(err.message);
      setEnrollment(null);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !confirm(
        "Delete your enrolled AWS Rekognition face vectors? You will need to complete liveness enrollment again.",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api("/faces/profile", { method: "DELETE" });
      setMessage(result.message);
      await load();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (enrollment)
    return (
      <>
        <Title
          over="BIOMETRIC IDENTITY"
          title="Secure face enrollment"
          text="AWS verifies liveness before creating your searchable face profile."
        />
        <LivenessCheck
          enrollment={enrollment}
          onComplete={complete}
          onCancel={() => setEnrollment(null)}
        />
        {message && <p className="status-message">{message}</p>}
      </>
    );
  return (
    <>
      <Title
        over="BIOMETRIC IDENTITY"
        title="Face recognition"
        text={
          user.role === "teacher"
            ? "Enroll your own face or operate a mobile entrance camera for an active class."
            : "Complete a secure liveness check to enable facial attendance."
        }
      />
      {!status ? (
        <section className="panel liveness-loading">
          <RefreshCw />
          <p>Checking AWS Rekognition configuration…</p>
        </section>
      ) : (
        <>
          <section className="panel biometric-status">
            <div
              className={`status-icon ${status.profile?.verified ? "verified" : ""}`}
            >
              {status.profile?.verified ? <Check /> : <ShieldCheck />}
            </div>
            <div>
              <small>FACE PROFILE</small>
              <h2>
                {status.profile?.verified
                  ? "Verified with AWS Rekognition"
                  : "Enrollment required"}
              </h2>
              <p>
                {status.profile?.verified
                  ? `Enrolled ${new Date(status.profile.enrolled_at).toLocaleString()}. Face vectors are stored in ${status.profile.collection_id}.`
                  : "Complete a liveness check before facial identification can recognize you."}
              </p>
              {!status.configured && (
                <p className="warning-box">
                  <AlertTriangle />
                  {!status.backendConfigured
                    ? "The server is missing REKOGNITION_COLLECTION_ID. "
                    : "The frontend liveness flow is missing COGNITO_IDENTITY_POOL_ID."}
                </p>
              )}
            </div>
            <div className="status-actions">
              {status.profile?.verified ? (
                <button className="danger" onClick={remove} disabled={busy}>
                  <Trash2 />
                  Delete face profile
                </button>
              ) : (
                <button
                  className="primary"
                  onClick={begin}
                  disabled={busy || !consent || !status.configured}
                >
                  <ScanFace />
                  {busy ? "Starting…" : "Begin liveness enrollment"}
                </button>
              )}
            </div>
          </section>
          {!status.profile?.verified && (
            <label className="biometric-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                <b>I consent to biometric processing</b>I understand that AWS
                Rekognition will create face vectors for identification and that
                I can delete my face profile from this page.
              </span>
            </label>
          )}
          {user.role === "teacher" &&
            status.profile?.verified &&
            status.backendConfigured && (
              <RecognitionCamera sessions={sessions} />
            )}
        </>
      )}
      {message && <p className="status-message">{message}</p>}
    </>
  );
}

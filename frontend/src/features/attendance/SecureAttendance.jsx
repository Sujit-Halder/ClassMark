import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  MapPin,
  QrCode,
  ScanFace,
  ShieldCheck,
  UserCheck,
  X,
} from "lucide-react";
import QrCameraScanner from "./QrCameraScanner.jsx";
import { getReliableLocation } from "../../lib/location.js";
import "../../styles/secure-attendance.css";

const API = import.meta.env.VITE_API_URL || "/api";
async function api(path, options = {}) {
  const response = await fetch(API + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.token}`,
      },
    }),
    data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.message || "Request failed.");
  return data;
}

function FaceCapture({ title, text, onVerified, purpose, sessionId }) {
  const video = useRef(null),
    canvas = useRef(null),
    stream = useRef(null);
  const [active, setActive] = useState(false),
    [image, setImage] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(
    () => () => stream.current?.getTracks().forEach((track) => track.stop()),
    [],
  );
  async function start() {
    setImage("");
    setMessage("");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 960 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      video.current.srcObject = stream.current;
      setActive(true);
    } catch {
      setMessage("Allow front camera access in your browser and use HTTPS.");
    }
  }
  function capture() {
    const source = video.current,
      target = canvas.current,
      scale = Math.min(1, 960 / source.videoWidth);
    target.width = Math.round(source.videoWidth * scale);
    target.height = Math.round(source.videoHeight * scale);
    target
      .getContext("2d")
      .drawImage(source, 0, 0, target.width, target.height);
    setImage(target.toDataURL("image/jpeg", 0.82));
    stream.current?.getTracks().forEach((track) => track.stop());
    setActive(false);
  }
  async function verify() {
    setBusy(true);
    setMessage("Authenticating your face…");
    try {
      const result = await api("/faces/authenticate", {
        method: "POST",
        body: JSON.stringify({ image, purpose, sessionId }),
      });
      if (result.profilePictureSaved)
        window.dispatchEvent(new Event("profile-picture-updated"));
      setMessage(result.message);
      onVerified(result);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel self-face">
      <div className="secure-heading">
        <span>
          <ShieldCheck />
        </span>
        <div>
          <small>FACE AUTHENTICATION</small>
          <h2>{title}</h2>
          <p>{text}</p>
        </div>
      </div>
      <div className="self-face-frame">
        {image ? (
          <img src={image} alt="Face authentication capture" />
        ) : (
          <video ref={video} autoPlay muted playsInline />
        )}
        <canvas ref={canvas} />
        {!active && !image && (
          <div>
            <ScanFace />
            <b>Front camera is ready</b>
            <small>Only one face should be visible</small>
          </div>
        )}
      </div>
      <div className="secure-actions">
        {!active && !image && (
          <button className="primary" onClick={start}>
            <Camera />
            Open front camera
          </button>
        )}
        {active && (
          <button className="primary" onClick={capture}>
            <ScanFace />
            Capture face
          </button>
        )}
        {image && (
          <>
            <button className="outline" onClick={start}>
              Retake
            </button>
            <button className="primary" onClick={verify} disabled={busy}>
              <UserCheck />
              {busy ? "Verifying…" : "Verify my identity"}
            </button>
          </>
        )}
      </div>
      {message && <p className="status-message">{message}</p>}
    </section>
  );
}

function TeacherAttendance() {
  const [rooms, setRooms] = useState([]),
    [roomId, setRoomId] = useState(""),
    [roomNumber, setRoomNumber] = useState(""),
    [radius, setRadius] = useState(75),
    [grant, setGrant] = useState(""),
    [session, setSession] = useState(null),
    [message, setMessage] = useState(""),
    [reviews, setReviews] = useState([]),
    [busy, setBusy] = useState(false);
  async function loadReviews() {
    try {
      setReviews(await api("/attendance/review-requests"));
    } catch {
      /* review list is optional */
    }
  }
  useEffect(() => {
    let current = true;
    Promise.all([api("/classrooms"), api("/attendance/review-requests")])
      .then(([items, pendingReviews]) => {
        if (!current) return;
        setRooms(items);
        setReviews(pendingReviews);
        if (items[0]) setRoomId(items[0].id);
      })
      .catch((error) => current && setMessage(error.message));
    return () => {
      current = false;
    };
  }, []);
  async function generate() {
    if (!grant)
      return setMessage("Verify your face before generating the QR code.");
    if (!roomId || !roomNumber)
      return setMessage("Choose a classroom and enter its room number.");
    setBusy(true);
    setMessage("Finding the most accurate GPS position…");
    try {
      const location = await getReliableLocation();
      const result = await api(`/classrooms/${roomId}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          roomNumber,
          radius,
          faceGrantId: grant,
          lat: location.lat,
          lng: location.lng,
          accuracy: location.accuracy,
        }),
      });
      setSession(result);
      setGrant("");
      setMessage(
        `Secure QR created. Teacher GPS accuracy: ±${Math.round(location.accuracy)} m.`,
      );
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(id, decision) {
    try {
      await api(`/attendance/review-requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      });
      await loadReviews();
      setMessage(`Manual attendance request ${decision}.`);
    } catch (error) {
      setMessage(error.message);
    }
  }
  if (!grant && !session)
    return (
      <>
        <div className="secure-title">
          <small>TEACHER AUTHORIZATION</small>
          <h1>Verify before taking attendance</h1>
          <p>
            Your face must match your enrolled profile before a QR session can
            be generated.
          </p>
        </div>
        <FaceCapture
          purpose="create-attendance"
          title="Confirm teacher identity"
          text="Capture a clear live-facing image. Authorization remains valid for five minutes and can create one QR session."
          onVerified={(result) => setGrant(result.faceGrantId)}
        />
        {reviews.length > 0 && (
          <ReviewQueue reviews={reviews} resolve={resolve} />
        )}
      </>
    );
  return (
    <>
      <div className="secure-title">
        <small>LOCATION-VERIFIED</small>
        <h1>Take attendance</h1>
        <p>
          Teacher face verified. Configure the classroom and generate the
          five-minute QR.
        </p>
      </div>
      <div className="attend">
        <section className="panel session">
          <div className="verified-chip">
            <Check />
            Teacher identity verified
          </div>
          <label>
            Classroom
            <select
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <option value="">Select classroom</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.subject} — {room.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Room number
            <input
              value={roomNumber}
              onChange={(event) => setRoomNumber(event.target.value)}
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
              onChange={(event) => setRadius(Number(event.target.value))}
            />
          </label>
          <button className="primary wide" onClick={generate} disabled={busy}>
            {busy ? "Verifying location…" : "Generate secure QR"}
          </button>
          {message && <p className="status-message">{message}</p>}
        </section>
        <section className="panel qr">
          {session ? (
            <>
              <span className="live">● LIVE SESSION</span>
              <img src={session.qrDataUrl} alt="Attendance QR" />
              <h3>{roomNumber}</h3>
              <p>Expires {new Date(session.expiresAt).toLocaleTimeString()}</p>
            </>
          ) : (
            <div>
              <QrCode />
              <h3>QR code appears here</h3>
            </div>
          )}
        </section>
      </div>
      <ReviewQueue reviews={reviews} resolve={resolve} />
    </>
  );
}

function ReviewQueue({ reviews, resolve }) {
  return (
    <section className="panel review-queue">
      <div className="secure-heading">
        <span>
          <UserCheck />
        </span>
        <div>
          <small>MANUAL VERIFICATION</small>
          <h2>Pending attendance requests</h2>
          <p>
            Approve only after confirming the student is physically present.
          </p>
        </div>
      </div>
      {reviews.length ? (
        reviews.map((review) => (
          <article key={review.id}>
            <div>
              <b>{review.studentName}</b>
              <span>
                {review.identifier || "No ID"} · {review.classroomName}
              </span>
              <small>{review.reason}</small>
            </div>
            <button
              className="outline"
              onClick={() => resolve(review.id, "rejected")}
            >
              <X />
              Reject
            </button>
            <button
              className="primary"
              onClick={() => resolve(review.id, "approved")}
            >
              <Check />
              Approve
            </button>
          </article>
        ))
      ) : (
        <p className="muted">No manual review requests are waiting.</p>
      )}
    </section>
  );
}

function StudentAttendance() {
  const [payload, setPayload] = useState(""),
    [pending, setPending] = useState(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [faceFailed, setFaceFailed] = useState(false);
  async function checkIn(scanned = payload) {
    setPayload(scanned);
    let parsed;
    try {
      parsed = JSON.parse(scanned);
    } catch {
      return setMessage("This is not a valid Classmark attendance QR code.");
    }
    if (parsed.type !== "classmark-attendance")
      return setMessage("This QR code is not a Classmark attendance session.");
    setBusy(true);
    setMessage("QR recognized. Finding an accurate GPS position…");
    try {
      const location = await getReliableLocation();
      const result = await api("/attendance/check-in", {
        method: "POST",
        body: JSON.stringify({
          sessionId: parsed.sessionId,
          code: parsed.code,
          lat: location.lat,
          lng: location.lng,
          accuracy: location.accuracy,
        }),
      });
      setPending({ sessionId: result.sessionId });
      setMessage(
        `${result.message} Distance: ${result.distance} m · GPS accuracy: ±${result.accuracy} m.`,
      );
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function requestReview() {
    try {
      const result = await api("/attendance/review-requests", {
        method: "POST",
        body: JSON.stringify({
          sessionId: pending.sessionId,
          reason:
            "Student could not complete self-face authentication after successful QR and proximity verification.",
        }),
      });
      setMessage(result.message);
      setFaceFailed(false);
    } catch (error) {
      setMessage(error.message);
    }
  }
  if (pending)
    return (
      <>
        <div className="secure-title">
          <small>STEP 2 OF 2</small>
          <h1>Complete face authentication</h1>
          <p>
            Your QR and classroom proximity passed. Attendance remains partial
            until your face or a teacher verifies it.
          </p>
        </div>
        <FaceCapture
          purpose="attendance"
          sessionId={pending.sessionId}
          title="Confirm your identity"
          text="Use the front camera and match your enrolled face profile."
          onVerified={(result) => {
            setMessage(result.message);
            setPending(null);
            setFaceFailed(false);
            window.dispatchEvent(
              new CustomEvent("classmark:navigate", {
                detail: {
                  page: "classes",
                  classroomId: result.classroomId,
                  tab: "marks",
                },
              }),
            );
          }}
        />
        <div className="manual-review-action">
          <button className="outline" onClick={() => setFaceFailed(true)}>
            <AlertTriangle />
            Face verification is not working
          </button>
          {faceFailed && (
            <div>
              <p>
                Request manual verification from a classroom teacher. Your QR
                and proximity result will remain attached to the request.
              </p>
              <button className="primary" onClick={requestReview}>
                Send manual review request
              </button>
            </div>
          )}
        </div>
        {message && <p className="status-message">{message}</p>}
      </>
    );
  return (
    <>
      <div className="secure-title">
        <small>STEP 1 OF 2</small>
        <h1>Scan attendance QR</h1>
        <p>
          First verify the live QR and your proximity. You will then
          authenticate your face.
        </p>
      </div>
      <section className="panel student-checkin">
        <QrCameraScanner onScan={checkIn} disabled={busy} />
        <details className="manual-qr">
          <summary>Having camera trouble?</summary>
          <textarea
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            placeholder="Paste decoded Classmark QR data"
          />
          <button className="outline" onClick={() => checkIn()} disabled={busy}>
            <MapPin />
            {busy ? "Verifying…" : "Verify pasted code"}
          </button>
        </details>
        {message && <p className="status-message">{message}</p>}
      </section>
    </>
  );
}

export default function SecureAttendance({ user }) {
  return (
    <div className="secure-attendance">
      {user.role === "teacher" ? <TeacherAttendance /> : <StudentAttendance />}
    </div>
  );
}

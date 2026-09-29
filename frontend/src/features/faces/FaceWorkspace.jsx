import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Trash2,
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
  const [Detector, setDetector] = useState(null),
    [error, setError] = useState("");
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
        "Camera access failed. Open this page over HTTPS and allow front-camera permission.",
      );
    else if (/credential|access.?denied|unauthorized/i.test(detail || ""))
      setError(
        "AWS could not authorize this check. The administrator must verify the Cognito identity pool policy.",
      );
    else
      setError(
        detail ||
          "The live camera check was interrupted. Keep this page open and retry on a stable connection.",
      );
  }
  return (
    <section className="panel liveness-panel">
      <div className="biometric-heading">
        <div>
          <small>LIVE ENROLLMENT</small>
          <h2>Quick live face check</h2>
          <p>
            Use the front camera, keep your face visible, and move closer when
            prompted.
          </p>
        </div>
        <button className="outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="liveness-tips">
        <span>
          <Check />
          Use soft, even light
        </span>
        <span>
          <Check />
          Remove face obstructions
        </span>
        <span>
          <Check />
          Hold the phone at eye level
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

export default function FaceWorkspace({ user, Title, onEnrolled }) {
  const [status, setStatus] = useState(null),
    [consent, setConsent] = useState(false),
    [enrollment, setEnrollment] = useState(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function load() {
    try {
      setStatus(await api("/faces/status"));
    } catch (error) {
      setMessage(error.message);
    }
  }
  useEffect(() => {
    let current = true;
    api("/faces/status")
      .then((result) => current && setStatus(result))
      .catch((error) => current && setMessage(error.message));
    return () => {
      current = false;
    };
  }, []);
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
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    setBusy(true);
    setMessage("Processing your live face result…");
    try {
      const result = await api("/faces/liveness/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId: enrollment.sessionId }),
      });
      setMessage(result.message);
      setEnrollment(null);
      await load();
      window.dispatchEvent(new Event("profile-picture-updated"));
      onEnrolled?.();
    } catch (error) {
      setMessage(error.message);
      setEnrollment(null);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !confirm(
        "Delete your enrolled AWS Rekognition face profile? You will need to enroll again before using classrooms or attendance.",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api("/faces/profile", { method: "DELETE" });
      setMessage(result.message);
      await load();
    } catch (error) {
      setMessage(error.message);
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
          text="Complete the short AWS live-face check using your front camera."
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
        title="Face profile"
        text="Manage the verified identity used for portal activation and attendance authentication."
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
              <small>IDENTITY STATUS</small>
              <h2>
                {status.profile?.verified
                  ? "Face identity verified"
                  : "Enrollment required"}
              </h2>
              <p>
                {status.profile?.verified
                  ? `Your verified identity was enrolled ${new Date(status.profile.enrolled_at).toLocaleString()}.`
                  : `Complete one secure live-face enrollment to activate this ${user.role} account.`}
              </p>
              {!status.configured && (
                <p className="warning-box">
                  <AlertTriangle />
                  {!status.backendConfigured
                    ? "The server is missing REKOGNITION_COLLECTION_ID. "
                    : "The liveness flow is missing COGNITO_IDENTITY_POOL_ID."}
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
                  {busy ? "Starting…" : "Begin secure enrollment"}
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
                Rekognition creates face vectors for identity matching and that
                I can delete this profile.
              </span>
            </label>
          )}
        </>
      )}
      {message && <p className="status-message">{message}</p>}
    </>
  );
}

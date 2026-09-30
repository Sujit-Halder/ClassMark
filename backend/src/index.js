import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, now, transaction } from "./database/database.js";
import {
  createLivenessSession,
  deleteEnrollment,
  enrollReferenceImage,
  faceConfig,
  getLivenessResult,
  identifyFace,
  providerUserId,
} from "./services/awsFaces.js";

const port = Number(process.env.PORT || 4000),
  secret = process.env.JWT_SECRET || "development-only-secret-change-me",
  appUrl = process.env.APP_URL || "http://localhost:5173",
  notificationRetentionDays = Math.max(
    1,
    Number(process.env.NOTIFICATION_RETENTION_DAYS) || 90,
  ),
  notificationReadLimit = Math.max(
    25,
    Number(process.env.NOTIFICATION_READ_LIMIT) || 200,
  );
const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function resolveDeviceClock(query) {
  const requestedTimeZone = String(query.timezone || "").slice(0, 100);
  try {
    const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: requestedTimeZone,
        weekday: "short",
      }),
      dateFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: requestedTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      dateKey = (date) => {
        const parts = Object.fromEntries(
          dateFormatter
            .formatToParts(date)
            .filter(({ type }) => type !== "literal")
            .map(({ type, value }) => [type, value]),
        );
        return `${parts.year}-${parts.month}-${parts.day}`;
      };
    return {
      weekday: weekdayNames.indexOf(weekdayFormatter.format(new Date())),
      today: dateKey(new Date()),
      dateKey,
      timeZone: requestedTimeZone,
    };
  } catch {
    const suppliedOffset = Number(query.offsetMinutes),
      offsetMinutes =
        Number.isFinite(suppliedOffset) && Math.abs(suppliedOffset) <= 14 * 60
          ? suppliedOffset
          : new Date().getTimezoneOffset(),
      shifted = (date) => new Date(date.getTime() - offsetMinutes * 60_000),
      dateKey = (date) => shifted(date).toISOString().slice(0, 10),
      localNow = shifted(new Date());
    return {
      weekday: localNow.getUTCDay(),
      today: dateKey(new Date()),
      dateKey,
      timeZone: null,
    };
  }
}
const relyingPartyId = process.env.WEBAUTHN_RP_ID || new URL(appUrl).hostname,
  relyingPartyOrigin = process.env.WEBAUTHN_ORIGIN || new URL(appUrl).origin,
  relyingPartyName = process.env.WEBAUTHN_RP_NAME || "Classmark";
const frontendDist = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "frontend",
  "dist",
);
if (!process.env.JWT_SECRET)
  console.warn(
    "[security] JWT_SECRET is missing. Set a long random value in backend/.env before deployment.",
  );
const administratorEmails = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
for (const email of administratorEmails)
  db.prepare("UPDATE users SET role='admin' WHERE lower(email)=?").run(email);
const hasVerifiedFace = (userId) =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM face_profiles WHERE user_id=? AND status='verified' AND revoked_at IS NULL",
      )
      .get(userId),
  );
const publicUser = (u) =>
  u && {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department,
    identifier: u.identifier,
    profileComplete: Boolean(u.profile_complete) && hasVerifiedFace(u.id),
    faceVerified: hasVerifiedFace(u.id),
    createdAt: u.created_at,
    hasProfilePicture: Boolean(u.profile_picture),
  };
function saveProfilePictureIfMissing(userId, image, imageType = "image/jpeg") {
  if (!image?.length || image.length > 2_000_000) return false;
  const result = db
    .prepare(
      "UPDATE users SET profile_picture=?,profile_picture_type=? WHERE id=? AND profile_picture IS NULL",
    )
    .run(image, imageType, userId);
  return Boolean(result.changes);
}
const tokenFor = (u, adminFaceAuthenticated = false) =>
  jwt.sign(
    {
      sub: u.id,
      role: u.role,
      adminFaceAuthenticated:
        u.role === "admin" ? adminFaceAuthenticated : undefined,
    },
    secret,
    { expiresIn: "7d" },
  );
function auth(req, res, next) {
  try {
    req.auth = jwt.verify(
      req.headers.authorization?.replace(/^Bearer /, ""),
      secret,
    );
    const currentAccount = db
      .prepare("SELECT role FROM users WHERE id=?")
      .get(req.auth.sub);
    if (!currentAccount)
      return res.status(401).json({ message: "This account is no longer available." });
    req.auth.role = currentAccount.role;
    const adminPreVerificationPaths = [
      "/api/profile",
      "/api/profile/picture",
      "/api/faces/status",
      "/api/faces/liveness/session",
      "/api/faces/liveness/complete",
      "/api/admin/auth/session",
      "/api/admin/auth/complete",
    ];
    if (
      req.auth.role === "admin" &&
      req.auth.adminFaceAuthenticated !== true &&
      !adminPreVerificationPaths.some((path) => req.path.startsWith(path))
    )
      return res.status(403).json({
        code: "ADMIN_FACE_AUTH_REQUIRED",
        message: "Complete live administrator face verification to continue.",
      });
    const faceEnrollmentPaths = [
      "/api/profile",
      "/api/settings",
      "/api/account/password",
      "/api/passkeys",
      "/api/faces/status",
      "/api/faces/liveness/session",
      "/api/faces/liveness/complete",
    ];
    if (
      req.auth.role !== "admin" &&
      !hasVerifiedFace(req.auth.sub) &&
      !faceEnrollmentPaths.some((path) => req.path.startsWith(path))
    )
      return res.status(403).json({
        code: "FACE_ENROLLMENT_REQUIRED",
        message: "Complete mandatory face enrollment before using the portal.",
      });
    next();
  } catch {
    res.status(401).json({ message: "Please sign in to continue." });
  }
}
function adminOnly(req, res, next) {
  if (
    req.auth.role !== "admin" ||
    req.auth.adminFaceAuthenticated !== true
  )
    return res.status(403).json({ message: "Administrator access is required." });
  next();
}
function audit(req, action, entityType, entityId, classroomId, details = {}) {
  db.prepare(
    "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,classroom_id,details,ip_address,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    req.auth?.sub || null,
    action,
    entityType,
    entityId || null,
    classroomId || null,
    JSON.stringify(details),
    req.ip || "",
    now(),
  );
}
function securityEvent(userId, eventType, severity, classroomId, details = {}) {
  db.prepare(
    "INSERT INTO security_events(id,user_id,event_type,severity,classroom_id,details,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    userId || null,
    eventType,
    severity,
    classroomId || null,
    JSON.stringify(details),
    now(),
  );
}
const distance = (a, b) => {
  const r = (n) => (n * Math.PI) / 180,
    dLat = r(b.lat - a.lat),
    dLng = r(b.lng - a.lng),
    x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
function classroomAccess(classroomId, userId) {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=?")
    .get(classroomId);
  if (!room) return null;
  const member = db
      .prepare("SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?")
      .get(classroomId, userId),
    teacher = db
      .prepare(
        "SELECT 1 FROM classroom_teachers WHERE classroom_id=? AND teacher_id=?",
      )
      .get(classroomId, userId);
  return room.teacher_id === userId || teacher || member ? room : null;
}
function canTeach(classroomId, userId) {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=?")
    .get(classroomId);
  if (!room) return null;
  return room.teacher_id === userId ||
    db
      .prepare(
        "SELECT 1 FROM classroom_teachers WHERE classroom_id=? AND teacher_id=?",
      )
      .get(classroomId, userId)
    ? room
    : null;
}
function recordExpiredAssignmentZeros(classroomId) {
  const expired = db
    .prepare(
      "SELECT id,due_at FROM assignments WHERE classroom_id=? AND due_at IS NOT NULL AND datetime(due_at)<=datetime('now')",
    )
    .all(classroomId);
  const students = db
    .prepare("SELECT user_id FROM memberships WHERE classroom_id=?")
    .all(classroomId);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO assignment_submissions(id,assignment_id,student_id,content,submitted_at,grade,feedback,graded_at) VALUES(?,?,?,'',?,?,?,?)",
  );
  transaction(() => {
    for (const assignment of expired) {
      const recorded = now();
      for (const student of students)
        insert.run(
          randomUUID(),
          assignment.id,
          student.user_id,
          assignment.due_at,
          0,
          "Not submitted before the deadline.",
          recorded,
        );
    }
  });
}
function classCode() {
  let code;
  do {
    code = randomBytes(8)
      .toString("base64url")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 10)
      .toUpperCase();
  } while (
    code.length !== 10 ||
    db.prepare("SELECT 1 FROM classrooms WHERE class_code=?").get(code)
  );
  return code;
}
function notificationEnabled(userId, type) {
  const settings = db
    .prepare(
      "SELECT email_notifications,attendance_notifications,invitation_notifications FROM user_settings WHERE user_id=?",
    )
    .get(userId);
  if (!settings) return true;
  return Boolean(
    type === "attendance"
      ? settings.attendance_notifications
      : type === "invitation"
        ? settings.invitation_notifications
        : settings.email_notifications,
  );
}
function notifyUser(userId, type, title, message, link = "/", force = false) {
  if (!userId || (!force && !notificationEnabled(userId, type))) return;
  const notification = {
    id: randomUUID(),
    userId,
    type,
    title,
    message,
    link,
    createdAt: now(),
  };
  db.prepare(
    "INSERT INTO notifications(id,user_id,type,title,message,link,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    notification.id,
    userId,
    type,
    title,
    message,
    link,
    notification.createdAt,
  );
}
function cleanupReadNotifications() {
  const cutoff = new Date(
    Date.now() - notificationRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const expired = db
    .prepare(
      "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at<?",
    )
    .run(cutoff).changes;
  const overLimit = db
    .prepare(
      `DELETE FROM notifications AS old WHERE old.read_at IS NOT NULL AND old.id NOT IN (SELECT recent.id FROM notifications AS recent WHERE recent.user_id=old.user_id AND recent.read_at IS NOT NULL ORDER BY recent.created_at DESC LIMIT ?)`,
    )
    .run(notificationReadLimit).changes;
  return Number(expired) + Number(overLimit);
}
function classroomRecipients(classroomId, excludeUserId) {
  return db
    .prepare(
      `SELECT user_id id FROM memberships WHERE classroom_id=? UNION SELECT teacher_id id FROM classroom_teachers WHERE classroom_id=? UNION SELECT teacher_id id FROM classrooms WHERE id=?`,
    )
    .all(classroomId, classroomId, classroomId)
    .map((row) => row.id)
    .filter((id) => id !== excludeUserId);
}
function classroomTeacherIds(classroomId) {
  return db
    .prepare(
      `SELECT teacher_id id FROM classroom_teachers WHERE classroom_id=? UNION SELECT teacher_id id FROM classrooms WHERE id=?`,
    )
    .all(classroomId, classroomId)
    .map((row) => row.id);
}
function notifyClassroom(
  classroomId,
  excludeUserId,
  type,
  title,
  message,
  link,
) {
  for (const userId of classroomRecipients(classroomId, excludeUserId))
    void notifyUser(userId, type, title, message, link);
}

function finalizeAttendanceSession(session) {
  let finalized = false;
  const finalizedAt = now();
  transaction(() => {
    const result = db
      .prepare(
        "UPDATE attendance_sessions SET finalized_at=? WHERE id=? AND finalized_at IS NULL",
      )
      .run(finalizedAt, session.id);
    if (!result.changes) return;
    finalized = true;
    db.prepare(
      `INSERT OR IGNORE INTO attendance_records(id,session_id,classroom_id,user_id,status,recorded_at) SELECT lower(hex(randomblob(16))),?,?,m.user_id,'absent',? FROM memberships m WHERE m.classroom_id=?`,
    ).run(
      session.id,
      session.classroom_id,
      finalizedAt,
      session.classroom_id,
    );
    db.prepare(
      "INSERT OR IGNORE INTO attendance_records(id,session_id,classroom_id,user_id,method,status,recorded_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      session.id,
      session.classroom_id,
      session.teacher_id,
      "qr-host",
      "present",
      finalizedAt,
    );
  });

  const records = db
    .prepare("SELECT * FROM attendance_records WHERE session_id=?")
    .all(session.id);
  if (!finalized) return { finalized, records };

  const room = db
    .prepare("SELECT name FROM classrooms WHERE id=?")
    .get(session.classroom_id);
  const studentRecords = records.filter(
    (record) => record.user_id !== session.teacher_id,
  );
  const marksLink = `/?page=classes&classroomId=${session.classroom_id}&tab=marks`;
  for (const record of studentRecords)
    void notifyUser(
      record.user_id,
      "attendance",
      `Attendance finalized: ${room.name}`,
      `Your attendance was marked ${record.status}.`,
      marksLink,
    );
  const present = studentRecords.filter(
    (record) => record.status === "present",
  ).length;
  for (const teacherId of classroomTeacherIds(session.classroom_id))
    void notifyUser(
      teacherId,
      "attendance",
      `Attendance results: ${room.name}`,
      `${present} present and ${studentRecords.length - present} absent. Open Marks to review the results.`,
      marksLink,
      true,
    );
  if (process.env.SMTP_HOST) {
    const teacherEmails = db
      .prepare(`SELECT DISTINCT u.email FROM users u JOIN (SELECT teacher_id id FROM classrooms WHERE id=? UNION SELECT teacher_id id FROM classroom_teachers WHERE classroom_id=?) teachers ON teachers.id=u.id`)
      .all(session.classroom_id, session.classroom_id)
      .map((teacher) => teacher.email);
    if (teacherEmails.length)
      void mailTransport().sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: teacherEmails.join(","),
        subject: `Attendance results: ${room.name}`,
        text: `${room.name} attendance was finalized.\n\nPresent: ${present}\nAbsent: ${studentRecords.length - present}\nTotal students: ${studentRecords.length}\n\nOpen Classmark to review the Marks section.`,
      }).catch((error) => console.error("[attendance summary email]", error.message));
  }
  return { finalized, records };
}

function finalizeExpiredAttendanceSessions() {
  const expired = db
    .prepare(
      "SELECT * FROM attendance_sessions WHERE finalized_at IS NULL AND expires_at<=? ORDER BY expires_at ASC",
    )
    .all(now());
  for (const session of expired) {
    try {
      finalizeAttendanceSession(session);
    } catch (error) {
      console.error(`[attendance auto-finalize] ${session.id}`, error);
    }
  }
  return expired.length;
}
function mailTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    family: 4,
    auth: {
      user: process.env.SMTP_USER,
      pass: String(process.env.SMTP_PASS || "").replace(/\s/g, ""),
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}
async function emailInvite(invite, room, teacher, requestOrigin) {
  const base = (requestOrigin || appUrl).replace(/\/$/, "");
  const link = `${base}/invite/${invite.token}`;
  if (!process.env.SMTP_HOST) {
    console.log(`[invite] ${invite.email}: ${link}`);
    return { link, delivery: "preview" };
  }
  try {
    const info = await mailTransport().sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: invite.email,
      subject: `${teacher.name} invited you to ${room.name}`,
      text: `Hello,\n\n${teacher.name} invited you to join ${room.name} (${room.subject}) as a ${invite.role}.\n\nAccept the invitation within 7 days:\n${link}\n\nSign in using the invited email address.`,
      html: `<p>Hello,</p><p><strong>${teacher.name}</strong> invited you to join <strong>${room.name}</strong> (${room.subject}) as a ${invite.role}.</p><p><a href="${link}">Accept classroom invitation</a></p><p>This link expires in 7 days. Sign in using the invited email address.</p>`,
    });
    return { link, delivery: "sent", messageId: info.messageId };
  } catch (error) {
    console.error("[invite email failed]", error.code || error.message);
    return {
      link,
      delivery: "failed",
      warning: `Invitation link created, but email delivery failed: ${error.code || "SMTP error"}.`,
    };
  }
}

const allowedOrigins = new Set([
  appUrl.replace(/\/$/, ""),
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
function isPrivateOrigin(origin) {
  try {
    const { hostname, protocol } = new URL(origin);
    if (!["http:", "https:"].includes(protocol)) return false;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      (/^172\.(\d+)\./.test(hostname) &&
        Number(hostname.split(".")[1]) >= 16 &&
        Number(hostname.split(".")[1]) <= 31)
    );
  } catch {
    return false;
  }
}
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message: "Too many authentication attempts. Please wait and try again.",
  },
});
const faceLimiter = rateLimit({
  windowMs: 3 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message:
      "Too many face verification attempts. Wait a few minutes and try again.",
  },
});
const app = express();
app.set("trust proxy", "loopback");
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "connect-src": [
          "'self'",
          "https://*.amazonaws.com",
          "wss://*.amazonaws.com",
        ],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "blob:"],
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'"],
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin) || isPrivateOrigin(origin))
        return callback(null, true);
      callback(new Error("Origin not allowed by CORS"));
    },
  }),
);
app.use(express.json({ limit: "8mb" }));
app.use("/api/auth", authLimiter);
app.use("/api/faces", faceLimiter);
app.get("/api/health", (_q, r) =>
  r.json({
    ok: true,
    database: "sqlite",
    authentication: "jwt",
    rekognition: faceConfig.backendConfigured,
  }),
);
app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      confirmPassword,
      role,
      department = "",
      identifier = "",
    } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase(),
      normalizedName = String(name || "").trim();
    if (!normalizedName || !normalizedEmail || !password || !["student", "teacher"].includes(role))
      return res
        .status(400)
        .json({ message: "Name, email, password and role are required." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ message: "Enter a valid email address." });
    if (role === "student" && !String(identifier).trim())
      return res
        .status(400)
        .json({
          message:
            "Enrollment ID or roll number is required for students.",
        });
    if (password !== confirmPassword)
      return res
        .status(400)
        .json({ message: "Password and confirm password must match." });
    if (
      password.length < 12 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    )
      return res
        .status(400)
        .json({
          message:
            "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol.",
        });
    const id = randomUUID(),
      created = now();
    transaction(() => {
      db.prepare(
        "INSERT INTO users(id,name,email,password_hash,role,department,identifier,profile_complete,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        normalizedName,
        normalizedEmail,
        bcrypt.hashSync(password, 12),
        role,
        String(department).trim(),
        String(identifier).trim(),
        role === "student" ? Number(Boolean(department && identifier)) : 0,
        created,
      );
      db.prepare(
        "INSERT INTO user_settings(user_id,updated_at) VALUES(?,?)",
      ).run(id, created);
    });
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    res.status(201).json({ token: tokenFor(u), user: publicUser(u) });
  } catch (e) {
    if (
      String(e).includes("idx_users_enrollment_id") ||
      String(e).includes("users.identifier")
    )
      return res
        .status(409)
        .json({
          message: "That enrollment ID or roll number is already registered.",
        });
    if (String(e).includes("UNIQUE"))
      return res
        .status(409)
        .json({ message: "That email is already registered." });
    throw e;
  }
});
app.post("/api/auth/login", async (req, res) => {
  const u = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get(String(req.body.email || "").trim().toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || "", u.password_hash))
    return res.status(401).json({ message: "Invalid email or password." });
  res.json({
    token: tokenFor(u),
    user: {
      ...publicUser(u),
      adminFaceAuthenticated: u.role !== "admin",
    },
  });
});
app.post("/api/passkeys/register/options", auth, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.auth.sub),
    existing = db
      .prepare("SELECT credential_id,transports FROM passkeys WHERE user_id=?")
      .all(user.id);
  const options = await generateRegistrationOptions({
    rpName: relyingPartyName,
    rpID: relyingPartyId,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    excludeCredentials: existing.map((item) => ({
      id: item.credential_id,
      transports: JSON.parse(item.transports || "[]"),
    })),
  });
  db.prepare("DELETE FROM webauthn_challenges WHERE user_id=? AND purpose='register'").run(user.id);
  db.prepare(
    "INSERT INTO webauthn_challenges(id,user_id,purpose,challenge,expires_at,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    user.id,
    "register",
    options.challenge,
    new Date(Date.now() + 5 * 60_000).toISOString(),
    now(),
  );
  res.json(options);
});
app.post("/api/passkeys/register/verify", auth, async (req, res) => {
  const challenge = db
    .prepare(
      "SELECT * FROM webauthn_challenges WHERE user_id=? AND purpose='register' AND expires_at>? ORDER BY created_at DESC LIMIT 1",
    )
    .get(req.auth.sub, now());
  if (!challenge)
    return res.status(410).json({ message: "Passkey setup expired. Start again." });
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: relyingPartyOrigin,
      expectedRPID: relyingPartyId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo)
      return res.status(400).json({ message: "Passkey verification failed." });
    const info = verification.registrationInfo;
    db.prepare(
      "INSERT INTO passkeys(id,user_id,credential_id,public_key,counter,transports,device_type,backed_up,name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      req.auth.sub,
      info.credential.id,
      Buffer.from(info.credential.publicKey),
      info.credential.counter,
      JSON.stringify(info.credential.transports || req.body.response.response?.transports || []),
      info.credentialDeviceType || null,
      info.credentialBackedUp ? 1 : 0,
      String(req.body.name || "Passkey").slice(0, 80),
      now(),
    );
    db.prepare("DELETE FROM webauthn_challenges WHERE id=?").run(challenge.id);
    audit(req, "passkey.registered", "passkey", info.credential.id, null);
    res.json({ ok: true, message: "Passkey added successfully." });
  } catch (error) {
    res.status(400).json({ message: `Passkey setup failed: ${error.message}` });
  }
});
app.post("/api/auth/passkey/options", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(),
    user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user)
    return res.status(404).json({ message: "No passkey account was found." });
  const credentials = db
    .prepare("SELECT credential_id,transports FROM passkeys WHERE user_id=?")
    .all(user.id);
  if (!credentials.length)
    return res.status(404).json({ message: "No passkey is registered for this account." });
  const options = await generateAuthenticationOptions({
    rpID: relyingPartyId,
    userVerification: "required",
    allowCredentials: credentials.map((item) => ({
      id: item.credential_id,
      transports: JSON.parse(item.transports || "[]"),
    })),
  });
  db.prepare("DELETE FROM webauthn_challenges WHERE user_id=? AND purpose='authenticate'").run(user.id);
  db.prepare(
    "INSERT INTO webauthn_challenges(id,user_id,email,purpose,challenge,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(randomUUID(), user.id, email, "authenticate", options.challenge, new Date(Date.now() + 5 * 60_000).toISOString(), now());
  res.json({ ...options, email });
});
app.post("/api/auth/passkey/verify", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(),
    user = db.prepare("SELECT * FROM users WHERE email=?").get(email),
    challenge = user && db
      .prepare("SELECT * FROM webauthn_challenges WHERE user_id=? AND purpose='authenticate' AND expires_at>? ORDER BY created_at DESC LIMIT 1")
      .get(user.id, now()),
    passkey = user && db
      .prepare("SELECT * FROM passkeys WHERE user_id=? AND credential_id=?")
      .get(user.id, req.body.response?.id);
  if (!user || !challenge || !passkey)
    return res.status(400).json({ message: "Passkey sign-in request is invalid or expired." });
  try {
    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: relyingPartyOrigin,
      expectedRPID: relyingPartyId,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: JSON.parse(passkey.transports || "[]"),
      },
      requireUserVerification: true,
    });
    if (!verification.verified)
      return res.status(401).json({ message: "Passkey verification failed." });
    db.prepare("UPDATE passkeys SET counter=?,last_used_at=? WHERE id=?").run(
      verification.authenticationInfo.newCounter,
      now(),
      passkey.id,
    );
    db.prepare("DELETE FROM webauthn_challenges WHERE id=?").run(challenge.id);
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (error) {
    securityEvent(user.id, "passkey.failure", "warning", null, { message: error.message });
    res.status(401).json({ message: `Passkey sign-in failed: ${error.message}` });
  }
});
app.get("/api/passkeys", auth, (req, res) => {
  res.json(db.prepare("SELECT id,name,device_type deviceType,backed_up backedUp,created_at createdAt,last_used_at lastUsedAt FROM passkeys WHERE user_id=? ORDER BY created_at DESC").all(req.auth.sub));
});
app.delete("/api/passkeys/:id", auth, (req, res) => {
  const result = db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(req.params.id, req.auth.sub);
  if (!result.changes) return res.status(404).json({ message: "Passkey not found." });
  audit(req, "passkey.deleted", "passkey", req.params.id, null);
  res.json({ ok: true, message: "Passkey removed." });
});
app.post("/api/auth/forgot-password", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(),
    u = db.prepare("SELECT id,name,email FROM users WHERE email=?").get(email);
  if (u) {
    const token = randomBytes(32).toString("hex"),
      hash = createHash("sha256").update(token).digest("hex"),
      expires = new Date(Date.now() + 30 * 60_000).toISOString();
    db.prepare(
      "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
    ).run(randomUUID(), u.id, hash, expires, now());
    const link = `${appUrl}/reset-password?token=${token}`;
    if (process.env.SMTP_HOST) {
      await mailTransport().sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: u.email,
        subject: "Reset your Classmark password",
        text: `Hello ${u.name}, reset your password within 30 minutes: ${link}`,
      });
    } else console.log(`[password reset] ${u.email}: ${link}`);
  }
  res.json({
    message: "If that account exists, a password reset link has been sent.",
  });
});
app.post("/api/auth/reset-password", (req, res) => {
  const password = String(req.body.password || "");
  if (
    password.length < 12 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  )
    return res
      .status(400)
      .json({
        message:
          "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol.",
      });
  const hash = createHash("sha256")
      .update(String(req.body.token || ""))
      .digest("hex"),
    record = db
      .prepare("SELECT * FROM password_reset_tokens WHERE token_hash=?")
      .get(hash);
  if (!record || record.used_at || new Date(record.expires_at) < new Date())
    return res
      .status(400)
      .json({ message: "This password reset link is invalid or expired." });
  transaction(() => {
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
      bcrypt.hashSync(password, 12),
      record.user_id,
    );
    db.prepare("UPDATE password_reset_tokens SET used_at=? WHERE id=?").run(
      now(),
      record.id,
    );
  });
  res.json({ message: "Password changed successfully. You can now sign in." });
});
app.get("/api/profile", auth, (req, res) => {
  const user = publicUser(
    db.prepare("SELECT * FROM users WHERE id=?").get(req.auth.sub),
  );
  res.json({
    ...user,
    adminFaceAuthenticated:
      user.role !== "admin" || req.auth.adminFaceAuthenticated === true,
  });
});
app.put("/api/profile", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.auth.sub),
    name = String(req.body.name ?? u.name).trim(),
    department = String(req.body.department ?? u.department).trim(),
    identifier = String(req.body.identifier ?? u.identifier).trim();
  if (!name)
    return res.status(400).json({ message: "Full name is required." });
  if (u.role !== "admin" && (!department || !identifier))
    return res.status(400).json({
      message:
        u.role === "teacher"
          ? "Department and faculty ID are required."
          : "Department and enrollment ID are required.",
    });
  try {
    db.prepare(
      "UPDATE users SET name=?,department=?,identifier=?,profile_complete=? WHERE id=?",
    ).run(
      name,
      department,
      identifier,
      u.role === "admin" ? 1 : Number(Boolean(department && identifier)),
      u.id,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      return res.status(409).json({
        message: "That faculty, enrollment, or roll number is already in use.",
      });
    throw error;
  }
  audit(req, "account.profile_updated", "user", u.id, null, { name, department, identifier });
  res.json(publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});
app.put("/api/profile/picture", auth, (req, res) => {
  const m = req.body.image?.match(
    /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/,
  );
  if (!m)
    return res
      .status(400)
      .json({ message: "A JPEG, PNG, or WebP image is required." });
  const image = Buffer.from(m[2], "base64");
  if (image.length > 2_000_000)
    return res
      .status(413)
      .json({ message: "Profile image must be under 2 MB." });
  db.prepare(
    "UPDATE users SET profile_picture=?,profile_picture_type=? WHERE id=?",
  ).run(image, m[1], req.auth.sub);
  res.json({ ok: true });
});
app.delete("/api/profile/picture", auth, (req, res) => {
  db.prepare(
    "UPDATE users SET profile_picture=NULL,profile_picture_type=NULL WHERE id=?",
  ).run(req.auth.sub);
  res.json({ ok: true });
});
app.get("/api/profile/picture/:id", auth, (req, res) => {
  const u = db
    .prepare(
      "SELECT profile_picture,profile_picture_type FROM users WHERE id=?",
    )
    .get(req.params.id);
  if (!u?.profile_picture) return res.status(404).end();
  res.type(u.profile_picture_type).send(u.profile_picture);
});
app.get("/api/settings", auth, (req, res) => {
  let s = db
    .prepare(
      "SELECT theme,font,email_notifications,attendance_notifications,invitation_notifications FROM user_settings WHERE user_id=?",
    )
    .get(req.auth.sub);
  if (!s) {
    db.prepare("INSERT INTO user_settings(user_id,updated_at) VALUES(?,?)").run(
      req.auth.sub,
      now(),
    );
    s = db
      .prepare(
        "SELECT theme,font,email_notifications,attendance_notifications,invitation_notifications FROM user_settings WHERE user_id=?",
      )
      .get(req.auth.sub);
  }
  res.json({
    ...s,
    emailNotifications: Boolean(s.email_notifications),
    attendanceNotifications: Boolean(s.attendance_notifications),
    invitationNotifications: Boolean(s.invitation_notifications),
  });
});
app.put("/api/settings", auth, (req, res) => {
  const {
    theme = "light",
    font = "dm-sans",
    emailNotifications = true,
    attendanceNotifications = true,
    invitationNotifications = true,
  } = req.body;
  if (!["light", "dark", "system"].includes(theme))
    return res.status(400).json({ message: "Invalid theme." });
  if (!["dm-sans", "system", "serif"].includes(font))
    return res.status(400).json({ message: "Invalid font preference." });
  if (
    ![emailNotifications, attendanceNotifications, invitationNotifications].every(
      (value) => typeof value === "boolean",
    )
  )
    return res.status(400).json({ message: "Notification preferences must be true or false." });
  db.prepare(
    "UPDATE user_settings SET theme=?,font=?,email_notifications=?,attendance_notifications=?,invitation_notifications=?,updated_at=? WHERE user_id=?",
  ).run(
    theme,
    font,
    +emailNotifications,
    +attendanceNotifications,
    +invitationNotifications,
    now(),
    req.auth.sub,
  );
  res.json({
    ok: true,
    message: "Your preferences have been updated successfully.",
  });
});
app.get("/api/notifications", auth, (req, res) => {
  if (req.auth.role === "admin")
    return res.json({ items: [], unread: 0 });
  const linked = db
    .prepare("SELECT id,link FROM notifications WHERE user_id=? AND link IS NOT NULL")
    .all(req.auth.sub);
  for (const item of linked) {
    const classroomId = item.link.match(/[?&]classroomId=([^&]+)/)?.[1];
    if (classroomId) {
      const room = db
        .prepare("SELECT archived_at FROM classrooms WHERE id=?")
        .get(decodeURIComponent(classroomId));
      if (!room || room.archived_at)
        db.prepare(
          "UPDATE notifications SET link=NULL,message=message||? WHERE id=?",
        ).run(room ? " (Classroom archived.)" : " (Classroom deleted.)", item.id);
      continue;
    }
    const invitationToken = item.link.match(/\/invite\/([^/?#]+)/)?.[1];
    if (
      invitationToken &&
      !db.prepare("SELECT 1 FROM invitations WHERE token=?").get(invitationToken)
    )
      db.prepare(
        "UPDATE notifications SET link=NULL,message=message||' (Invitation is no longer available.)' WHERE id=?",
      ).run(item.id);
  }
  const items = db
      .prepare(
        "SELECT id,type,title,message,link,read_at readAt,created_at createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC",
      )
      .all(req.auth.sub),
    unread = db
      .prepare(
        "SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL",
      )
      .get(req.auth.sub).count;
  res.json({ items, unread });
});
app.patch("/api/notifications/read-all", auth, (req, res) => {
  db.prepare(
    "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",
  ).run(now(), req.auth.sub);
  res.json({ ok: true });
});
app.patch("/api/notifications/:id/read", auth, (req, res) => {
  const result = db
    .prepare("UPDATE notifications SET read_at=? WHERE id=? AND user_id=?")
    .run(now(), req.params.id, req.auth.sub);
  if (!result.changes)
    return res.status(404).json({ message: "Notification not found." });
  res.json({ ok: true });
});
app.put("/api/account/password", auth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || ""),
    newPassword = String(req.body.newPassword || ""),
    confirmPassword = String(req.body.confirmPassword || ""),
    u = db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(req.auth.sub);
  if (!u || !bcrypt.compareSync(currentPassword, u.password_hash))
    return res.status(401).json({ message: "Current password is incorrect." });
  if (newPassword !== confirmPassword)
    return res
      .status(400)
      .json({ message: "New password and confirmation do not match." });
  if (
    newPassword.length < 12 ||
    !/[a-z]/.test(newPassword) ||
    !/[A-Z]/.test(newPassword) ||
    !/[0-9]/.test(newPassword) ||
    !/[^A-Za-z0-9]/.test(newPassword)
  )
    return res
      .status(400)
      .json({
        message:
          "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol.",
      });
  if (bcrypt.compareSync(newPassword, u.password_hash))
    return res
      .status(400)
      .json({
        message: "Choose a password different from your current password.",
      });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
    bcrypt.hashSync(newPassword, 12),
    req.auth.sub,
  );
  audit(req, "account.password_changed", "user", req.auth.sub, null);
  res.json({ ok: true, message: "Password changed successfully." });
});
app.get("/api/classrooms", auth, (req, res) => {
  const archived = req.query.archived === "true";
  if (req.auth.role === "admin")
    return res.json(
      db
        .prepare(
          `SELECT c.*,(SELECT COUNT(*) FROM memberships m WHERE m.classroom_id=c.id) memberCount,'administrator' classroomRole FROM classrooms c WHERE c.archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY c.name`,
        )
        .all(),
    );
  const sql =
    req.auth.role === "teacher"
      ? `SELECT DISTINCT c.*,(SELECT COUNT(*) FROM memberships m WHERE m.classroom_id=c.id) memberCount,CASE WHEN c.teacher_id=? THEN 'owner' ELSE 'teacher' END classroomRole FROM classrooms c LEFT JOIN classroom_teachers ct ON ct.classroom_id=c.id WHERE (c.teacher_id=? OR ct.teacher_id=?) AND c.archived_at IS ${archived ? "NOT NULL" : "NULL"}`
      : `SELECT c.id,c.teacher_id,c.name,c.subject,c.section,c.color,c.created_at,c.archived_at,(SELECT COUNT(*) FROM memberships x WHERE x.classroom_id=c.id) memberCount,'student' classroomRole FROM classrooms c JOIN memberships m ON m.classroom_id=c.id WHERE m.user_id=? AND c.archived_at IS ${archived ? "NOT NULL" : "NULL"}`;
  res.json(
    req.auth.role === "teacher"
      ? db.prepare(sql).all(req.auth.sub, req.auth.sub, req.auth.sub)
      : db.prepare(sql).all(req.auth.sub),
  );
});
app.patch("/api/classrooms/:id/restore", auth, (req, res) => {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=? AND teacher_id=?")
    .get(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only the classroom owner can restore it." });
  db.prepare("UPDATE classrooms SET archived_at=NULL WHERE id=?").run(room.id);
  res.json({ ok: true, message: "Classroom restored." });
});
app.get("/api/people", auth, (req, res) => {
  if (req.auth.role !== "teacher")
    return res.status(403).json({ message: "Teacher access is required." });
  const classrooms = db
    .prepare(
      `SELECT DISTINCT c.id,c.name,c.subject FROM classrooms c LEFT JOIN classroom_teachers ct ON ct.classroom_id=c.id WHERE (c.teacher_id=? OR ct.teacher_id=?) AND c.archived_at IS NULL ORDER BY c.name`,
    )
    .all(req.auth.sub, req.auth.sub);
  const people = db
    .prepare(
      `SELECT u.id,u.name,u.email,u.role,u.department,u.identifier,COUNT(DISTINCT access.classroom_id) classroomCount,GROUP_CONCAT(DISTINCT c.name) classroomNames FROM users u JOIN (SELECT m.user_id,m.classroom_id FROM memberships m UNION SELECT ct.teacher_id user_id,ct.classroom_id FROM classroom_teachers ct UNION SELECT owner.teacher_id user_id,owner.id classroom_id FROM classrooms owner) access ON access.user_id=u.id JOIN classrooms c ON c.id=access.classroom_id LEFT JOIN classroom_teachers mine ON mine.classroom_id=c.id WHERE (c.teacher_id=? OR mine.teacher_id=?) AND c.archived_at IS NULL GROUP BY u.id ORDER BY u.role DESC,u.name`,
    )
    .all(req.auth.sub, req.auth.sub);
  res.json({ classrooms, people });
});
app.get("/api/search", auth, (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 80);
  if (query.length < 2) return res.json({ items: [] });
  const match = `%${query}%`;
  let classroomIds;
  if (req.auth.role === "admin")
    classroomIds = db
      .prepare("SELECT id FROM classrooms WHERE archived_at IS NULL")
      .all()
      .map(({ id }) => id);
  else if (req.auth.role === "teacher")
    classroomIds = db
      .prepare(
        "SELECT DISTINCT c.id FROM classrooms c LEFT JOIN classroom_teachers ct ON ct.classroom_id=c.id WHERE c.archived_at IS NULL AND (c.teacher_id=? OR ct.teacher_id=?)",
      )
      .all(req.auth.sub, req.auth.sub)
      .map(({ id }) => id);
  else
    classroomIds = db
      .prepare(
        "SELECT c.id FROM classrooms c JOIN memberships m ON m.classroom_id=c.id WHERE c.archived_at IS NULL AND m.user_id=?",
      )
      .all(req.auth.sub)
      .map(({ id }) => id);
  const placeholders = classroomIds.map(() => "?").join(","),
    items = [];
  if (classroomIds.length) {
    for (const room of db
      .prepare(
        `SELECT id,name,subject,section FROM classrooms WHERE id IN (${placeholders}) AND (name LIKE ? OR subject LIKE ? OR section LIKE ?) ORDER BY name LIMIT 6`,
      )
      .all(...classroomIds, match, match, match))
      items.push({
        type: "classroom",
        title: room.name,
        subtitle: `${room.subject}${room.section ? ` · ${room.section}` : ""}`,
        page: req.auth.role === "admin" ? "admin" : "classes",
        classroomId: req.auth.role === "admin" ? "" : room.id,
        tab: "stream",
      });
    for (const assignment of db
      .prepare(
        `SELECT a.id,a.classroom_id classroomId,a.title,c.name classroomName FROM assignments a JOIN classrooms c ON c.id=a.classroom_id WHERE a.classroom_id IN (${placeholders}) AND (a.title LIKE ? OR a.description LIKE ?) ORDER BY a.created_at DESC LIMIT 6`,
      )
      .all(...classroomIds, match, match))
      items.push({
        type: "assignment",
        title: assignment.title,
        subtitle: assignment.classroomName,
        page: req.auth.role === "admin" ? "admin" : "classes",
        classroomId: req.auth.role === "admin" ? "" : assignment.classroomId,
        tab: "assignments",
        assignmentId: assignment.id,
      });
    for (const resource of db
      .prepare(
        `SELECT r.classroom_id classroomId,r.title,c.name classroomName FROM classroom_resources r JOIN classrooms c ON c.id=r.classroom_id WHERE r.classroom_id IN (${placeholders}) AND (r.title LIKE ? OR r.description LIKE ?) ORDER BY r.created_at DESC LIMIT 6`,
      )
      .all(...classroomIds, match, match))
      items.push({
        type: "resource",
        title: resource.title,
        subtitle: resource.classroomName,
        page: req.auth.role === "admin" ? "admin" : "classes",
        classroomId: req.auth.role === "admin" ? "" : resource.classroomId,
        tab: "stream",
      });
    for (const person of db
      .prepare(
        `SELECT u.id,u.name,u.email,u.role,u.identifier,MIN(access.classroom_id) classroomId FROM users u JOIN (SELECT user_id,classroom_id FROM memberships UNION SELECT teacher_id user_id,classroom_id FROM classroom_teachers UNION SELECT teacher_id user_id,id classroom_id FROM classrooms) access ON access.user_id=u.id WHERE access.classroom_id IN (${placeholders}) AND u.id<>? AND (u.name LIKE ? OR u.email LIKE ? OR u.identifier LIKE ?) GROUP BY u.id ORDER BY u.name LIMIT 6`,
      )
      .all(...classroomIds, req.auth.sub, match, match, match))
      items.push({
        type: person.role,
        title: person.name,
        subtitle: `${person.role} · ${person.identifier || person.email}`,
        page: req.auth.role === "admin" ? "admin" : "classes",
        classroomId: req.auth.role === "admin" ? "" : person.classroomId,
        tab: "people",
      });
  }
  res.json({ items: items.slice(0, 20) });
});
app.get("/api/overview", auth, (req, res) => {
  const teacher = req.auth.role === "teacher";
  const access = teacher
    ? "(c.teacher_id=? OR EXISTS(SELECT 1 FROM classroom_teachers ct WHERE ct.classroom_id=c.id AND ct.teacher_id=?))"
    : "EXISTS(SELECT 1 FROM memberships m WHERE m.classroom_id=c.id AND m.user_id=?)";
  const params = teacher ? [req.auth.sub, req.auth.sub] : [req.auth.sub];
  const attendanceRecords = db
    .prepare(
      `SELECT COUNT(*) count FROM attendance_records a JOIN classrooms c ON c.id=a.classroom_id WHERE ${access}${teacher ? " AND a.user_id<>c.teacher_id" : " AND a.user_id=?"}`,
    )
    .get(...params, ...(teacher ? [] : [req.auth.sub])).count;
  const deviceClock = resolveDeviceClock(req.query),
    recentSessions = db
    .prepare(
      `SELECT s.starts_at FROM attendance_sessions s JOIN classrooms c ON c.id=s.classroom_id WHERE ${access} AND datetime(s.starts_at)>=datetime('now','-2 days') AND datetime(s.starts_at)<=datetime('now','+2 days')`,
    )
    .all(...params),
    sessionsToday = recentSessions.filter(
      ({ starts_at: startsAt }) =>
        deviceClock.dateKey(new Date(startsAt)) === deviceClock.today,
    ).length,
    classesToday = db
      .prepare(
        `SELECT COUNT(*) count FROM class_schedules cs JOIN classrooms c ON c.id=cs.classroom_id WHERE ${access} AND c.archived_at IS NULL AND cs.weekday=?`,
      )
      .get(...params, deviceClock.weekday).count;
  res.json({
    attendanceRecords,
    sessionsToday,
    classesToday,
    timeZone: deviceClock.timeZone,
  });
});
app.get("/api/classrooms/:id", auth, (req, res) => {
  const room = db
    .prepare(
      `SELECT c.*,u.name teacher_name,u.email teacher_email,(SELECT COUNT(*) FROM memberships m WHERE m.classroom_id=c.id) memberCount FROM classrooms c JOIN users u ON u.id=c.teacher_id WHERE c.id=?`,
    )
    .get(req.params.id);
  if (!room) return res.status(404).json({ message: "Classroom not found." });
  const teacher = canTeach(room.id, req.auth.sub),
    member = db
      .prepare("SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?")
      .get(room.id, req.auth.sub);
  if (!teacher && !member)
    return res
      .status(403)
      .json({ message: "You do not have access to this classroom." });
  if (!teacher) {
    delete room.class_code;
    delete room.is_locked;
  }
  res.json(room);
});
app.get("/api/classrooms/:id/members", auth, (req, res) => {
  if (!classroomAccess(req.params.id, req.auth.sub))
    return res.status(403).json({ message: "You do not have access." });
  res.json(
    db
      .prepare(
        `SELECT u.id,u.name,u.email,u.department,u.identifier,m.joined_at joinedAt FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.classroom_id=? ORDER BY u.name`,
      )
      .all(req.params.id),
  );
});
app.delete("/api/classrooms/:id/members/me", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res
      .status(403)
      .json({ message: "Only students can leave a classroom." });
  const result = db
    .prepare("DELETE FROM memberships WHERE classroom_id=? AND user_id=?")
    .run(req.params.id, req.auth.sub);
  if (!result.changes)
    return res.status(404).json({ message: "Enrollment not found." });
  res.json({ ok: true });
});
app.delete("/api/classrooms/:id/members/:userId", auth, (req, res) => {
  if (!canTeach(req.params.id, req.auth.sub))
    return res
      .status(403)
      .json({ message: "Only a classroom teacher can remove students." });
  db.prepare("DELETE FROM memberships WHERE classroom_id=? AND user_id=?").run(
    req.params.id,
    req.params.userId,
  );
  res.json({ ok: true });
});
app.get("/api/classrooms/:id/teachers", auth, (req, res) => {
  const room = classroomAccess(req.params.id, req.auth.sub);
  if (!room)
    return res.status(403).json({ message: "You do not have access." });
  const owner = db
      .prepare(
        `SELECT id,name,email,department,identifier,'owner' classroomRole FROM users WHERE id=?`,
      )
      .get(room.teacher_id),
    others = db
      .prepare(
        `SELECT u.id,u.name,u.email,u.department,u.identifier,'teacher' classroomRole FROM classroom_teachers ct JOIN users u ON u.id=ct.teacher_id WHERE ct.classroom_id=? ORDER BY u.name`,
      )
      .all(room.id);
  res.json([owner, ...others]);
});
app.post("/api/classrooms/join", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res
      .status(403)
      .json({ message: "Only students join with a classroom code." });
  if (!hasVerifiedFace(req.auth.sub))
    return res
      .status(403)
      .json({
        message: "Complete your face verification before joining a classroom.",
      });
  const code = String(req.body.code || "")
      .trim()
      .toUpperCase(),
    room = db
      .prepare(
        "SELECT * FROM classrooms WHERE class_code=? AND archived_at IS NULL",
      )
      .get(code);
  if (!room)
    return res.status(404).json({ message: "Classroom code not found." });
  if (room.is_locked)
    return res
      .status(423)
      .json({
        message: "This classroom is locked. Ask a teacher for an invitation.",
      });
  db.prepare(
    "INSERT OR IGNORE INTO memberships(id,classroom_id,user_id,joined_at) VALUES(?,?,?,?)",
  ).run(randomUUID(), room.id, req.auth.sub, now());
  res.json({ ok: true, classroomId: room.id, name: room.name });
});
app.patch("/api/classrooms/:id/lock", auth, (req, res) => {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=? AND teacher_id=?")
    .get(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only the classroom owner can change the lock." });
  const locked = req.body.locked ? 1 : 0;
  db.prepare("UPDATE classrooms SET is_locked=? WHERE id=?").run(
    locked,
    room.id,
  );
  res.json({ ok: true, locked: Boolean(locked) });
});
app.put("/api/classrooms/:id", auth, (req, res) => {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=? AND teacher_id=?")
    .get(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only the classroom owner can edit it." });
  const name = String(req.body.name || "").trim(),
    subject = String(req.body.subject || "").trim(),
    section = String(req.body.section || "").trim(),
    color = String(req.body.color || room.color);
  if (!name || !subject)
    return res
      .status(400)
      .json({ message: "Class name and subject are required." });
  if (!/^#[0-9a-f]{6}$/i.test(color))
    return res.status(400).json({ message: "Choose a valid classroom color." });
  db.prepare(
    "UPDATE classrooms SET name=?,subject=?,section=?,color=? WHERE id=?",
  ).run(name, subject, section, color, room.id);
  res.json(db.prepare("SELECT * FROM classrooms WHERE id=?").get(room.id));
});
app.patch("/api/classrooms/:id/archive", auth, (req, res) => {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=? AND teacher_id=?")
    .get(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only the classroom owner can archive it." });
  db.prepare("UPDATE classrooms SET archived_at=? WHERE id=?").run(
    now(),
    room.id,
  );
  db.prepare(
    "UPDATE notifications SET link=NULL,message=message||' (Classroom archived.)' WHERE link LIKE ?",
  ).run(`%classroomId=${room.id}%`);
  audit(req, "classroom.archived", "classroom", room.id, room.id);
  res.json({ ok: true });
});
app.delete("/api/classrooms/:id", auth, (req, res) => {
  const room = db
    .prepare("SELECT * FROM classrooms WHERE id=? AND teacher_id=?")
    .get(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only the classroom owner can delete it." });
  const invitationTokens = db
    .prepare("SELECT token FROM invitations WHERE classroom_id=?")
    .all(room.id);
  transaction(() => {
    db.prepare(
      "UPDATE notifications SET link=NULL,message=message||' (Classroom deleted.)' WHERE link LIKE ?",
    ).run(`%classroomId=${room.id}%`);
    for (const invitation of invitationTokens)
      db.prepare(
        "UPDATE notifications SET link=NULL,message=message||' (Classroom deleted.)' WHERE link LIKE ?",
      ).run(`%/invite/${invitation.token}%`);
    db.prepare("DELETE FROM classrooms WHERE id=?").run(room.id);
  });
  audit(req, "classroom.deleted", "classroom", room.id, null, { name: room.name, subject: room.subject });
  res.json({ ok: true });
});
app.get("/api/classrooms/:id/posts", auth, (req, res) => {
  if (!classroomAccess(req.params.id, req.auth.sub))
    return res.status(403).json({ message: "You do not have access." });
  res.json(
    db
      .prepare(
        `SELECT p.id,p.content,p.post_type postType,p.reference_id referenceId,p.created_at createdAt,u.id authorId,u.name authorName,u.role authorRole,r.title resourceTitle,r.url resourceUrl FROM classroom_posts p JOIN users u ON u.id=p.author_id LEFT JOIN classroom_resources r ON p.post_type='resource' AND r.id=p.reference_id WHERE p.classroom_id=? ORDER BY p.created_at DESC`,
      )
      .all(req.params.id),
  );
});
app.post("/api/classrooms/:id/posts", auth, (req, res) => {
  const room = canTeach(req.params.id, req.auth.sub);
  if (!room)
    return res.status(403).json({ message: "Only classroom teachers can post announcements." });
  const content = String(req.body.content || "").trim();
  if (!content)
    return res.status(400).json({ message: "Post cannot be empty." });
  const post = { id: randomUUID(), createdAt: now() };
  db.prepare(
    "INSERT INTO classroom_posts(id,classroom_id,author_id,content,created_at) VALUES(?,?,?,?,?)",
  ).run(post.id, room.id, req.auth.sub, content, post.createdAt);
  notifyClassroom(
    room.id,
    req.auth.sub,
    "general",
    `New post in ${room.name}`,
    content.slice(0, 160),
    `/?page=classes&classroomId=${room.id}&tab=stream`,
  );
  res
    .status(201)
    .json({
      ...post,
      content,
      authorId: req.auth.sub,
      authorName: db
        .prepare("SELECT name FROM users WHERE id=?")
        .get(req.auth.sub).name,
      authorRole: req.auth.role,
    });
});
app.delete("/api/classrooms/:id/posts/:postId", auth, (req, res) => {
  const room = classroomAccess(req.params.id, req.auth.sub),
    post = db
      .prepare(
        "SELECT author_id FROM classroom_posts WHERE id=? AND classroom_id=?",
      )
      .get(req.params.postId, req.params.id);
  if (
    !room ||
    !post ||
    (post.author_id !== req.auth.sub && !canTeach(room.id, req.auth.sub))
  )
    return res.status(403).json({ message: "You cannot delete this post." });
  db.prepare("DELETE FROM classroom_posts WHERE id=?").run(req.params.postId);
  res.json({ ok: true });
});
app.get("/api/classrooms/:id/assignments", auth, (req, res) => {
  if (!classroomAccess(req.params.id, req.auth.sub))
    return res.status(403).json({ message: "You do not have access." });
  recordExpiredAssignmentZeros(req.params.id);
  const rows = db
    .prepare(
      `SELECT a.*,s.id submissionId,s.content submissionContent,s.submitted_at submittedAt,s.grade,s.feedback,CASE WHEN a.due_at IS NOT NULL AND datetime(a.due_at)<=datetime('now') THEN 1 ELSE 0 END isExpired FROM assignments a LEFT JOIN assignment_submissions s ON s.assignment_id=a.id AND s.student_id=? WHERE a.classroom_id=? ORDER BY COALESCE(a.due_at,a.created_at) ASC`,
    )
    .all(req.auth.sub, req.params.id);
  res.json(rows);
});
app.post("/api/classrooms/:id/assignments", auth, (req, res) => {
  const room = canTeach(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only a classroom teacher can create assignments." });
  const { title, description = "", dueAt = null, points = 100 } = req.body;
  if (!String(title || "").trim())
    return res.status(400).json({ message: "Assignment title is required." });
  const item = {
    id: randomUUID(),
    title: title.trim(),
    description,
    dueAt: dueAt || null,
    points: Math.max(1, Number(points) || 100),
    createdAt: now(),
  };
  transaction(() => {
    db.prepare(
      "INSERT INTO assignments(id,classroom_id,title,description,due_at,points,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      item.id,
      room.id,
      item.title,
      item.description,
      item.dueAt,
      item.points,
      req.auth.sub,
      item.createdAt,
    );
    db.prepare(
      "INSERT INTO classroom_posts(id,classroom_id,author_id,content,post_type,reference_id,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      room.id,
      req.auth.sub,
      `New assignment: ${item.title}`,
      "assignment",
      item.id,
      item.createdAt,
    );
  });
  notifyClassroom(
    room.id,
    req.auth.sub,
    "general",
    `New assignment in ${room.name}`,
    item.title,
    `/?page=classes&classroomId=${room.id}&tab=assignments&assignmentId=${item.id}`,
  );
  res.status(201).json(item);
});
app.put("/api/assignments/:id", auth, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id=?")
    .get(req.params.id);
  if (!assignment || !canTeach(assignment.classroom_id, req.auth.sub))
    return res
      .status(403)
      .json({ message: "Only a classroom teacher can edit assignments." });
  const title = String(req.body.title || "").trim(),
    description = String(req.body.description || ""),
    dueAt = req.body.dueAt || null,
    points = Number(req.body.points);
  if (!title || !Number.isFinite(points) || points <= 0)
    return res
      .status(400)
      .json({ message: "A title and positive point value are required." });
  const highest = db
    .prepare(
      "SELECT MAX(grade) highest FROM assignment_submissions WHERE assignment_id=?",
    )
    .get(assignment.id).highest;
  if (highest != null && points < highest)
    return res
      .status(400)
      .json({
        message: `Points cannot be lower than the existing highest grade (${highest}).`,
      });
  transaction(() => {
    db.prepare(
      "UPDATE assignments SET title=?,description=?,due_at=?,points=? WHERE id=?",
    ).run(title, description, dueAt, points, assignment.id);
    db.prepare(
      "UPDATE classroom_posts SET content=? WHERE post_type='assignment' AND reference_id=?",
    ).run(`Assignment updated: ${title}`, assignment.id);
  });
  res.json({ ok: true });
});
app.delete("/api/assignments/:id", auth, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id=?")
    .get(req.params.id);
  if (!assignment || !canTeach(assignment.classroom_id, req.auth.sub))
    return res
      .status(403)
      .json({ message: "Only a classroom teacher can delete assignments." });
  transaction(() => {
    db.prepare(
      "DELETE FROM classroom_posts WHERE post_type='assignment' AND reference_id=?",
    ).run(assignment.id);
    db.prepare("DELETE FROM assignments WHERE id=?").run(assignment.id);
  });
  res.json({ ok: true });
});
app.get("/api/classrooms/:id/resources", auth, (req, res) => {
  if (!classroomAccess(req.params.id, req.auth.sub))
    return res.status(403).json({ message: "You do not have access." });
  res.json(
    db
      .prepare(
        "SELECT * FROM classroom_resources WHERE classroom_id=? ORDER BY created_at DESC",
      )
      .all(req.params.id),
  );
});
app.post("/api/classrooms/:id/resources", auth, (req, res) => {
  const room = canTeach(req.params.id, req.auth.sub);
  if (!room)
    return res
      .status(403)
      .json({ message: "Only a classroom teacher can share resources." });
  const title = String(req.body.title || "").trim(),
    url = String(req.body.url || "").trim(),
    description = String(req.body.description || "").trim();
  if (!title || !/^https?:\/\//i.test(url))
    return res
      .status(400)
      .json({
        message: "A title and valid http(s) resource URL are required.",
      });
  const item = { id: randomUUID(), createdAt: now() };
  transaction(() => {
    db.prepare(
      "INSERT INTO classroom_resources(id,classroom_id,title,url,description,shared_by,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      item.id,
      room.id,
      title,
      url,
      description,
      req.auth.sub,
      item.createdAt,
    );
    db.prepare(
      "INSERT INTO classroom_posts(id,classroom_id,author_id,content,post_type,reference_id,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      room.id,
      req.auth.sub,
      description || `Shared resource: ${title}`,
      "resource",
      item.id,
      item.createdAt,
    );
  });
  notifyClassroom(
    room.id,
    req.auth.sub,
    "general",
    `New resource in ${room.name}`,
    title,
    `/?page=classes&classroomId=${room.id}&tab=stream`,
  );
  res.status(201).json({ ...item, title, url, description });
});
app.post("/api/assignments/:id/submit", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res
      .status(403)
      .json({ message: "Only students submit assignments." });
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id=?")
    .get(req.params.id);
  if (!assignment || !classroomAccess(assignment.classroom_id, req.auth.sub))
    return res.status(403).json({ message: "Assignment unavailable." });
  if (assignment.due_at && new Date(assignment.due_at) <= new Date()) {
    recordExpiredAssignmentZeros(assignment.classroom_id);
    return res
      .status(409)
      .json({
        message:
          "The deadline has passed. This assignment can no longer be submitted and is recorded as 0.",
      });
  }
  const content = String(req.body.content || "").trim();
  if (!content)
    return res.status(400).json({ message: "Submission cannot be empty." });
  const id = randomUUID(),
    submitted = now();
  db.prepare(
    `INSERT INTO assignment_submissions(id,assignment_id,student_id,content,submitted_at) VALUES(?,?,?,?,?) ON CONFLICT(assignment_id,student_id) DO UPDATE SET content=excluded.content,submitted_at=excluded.submitted_at,grade=NULL,feedback=NULL,graded_at=NULL`,
  ).run(id, assignment.id, req.auth.sub, content, submitted);
  res.status(201).json({ id, submittedAt: submitted });
});
app.get("/api/assignments/:id/submissions", auth, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id=?")
    .get(req.params.id);
  if (!assignment || !canTeach(assignment.classroom_id, req.auth.sub))
    return res
      .status(403)
      .json({ message: "Only a classroom teacher can review submissions." });
  res.json(
    db
      .prepare(
        `SELECT s.*,u.name studentName,u.email studentEmail,u.identifier FROM assignment_submissions s JOIN users u ON u.id=s.student_id WHERE s.assignment_id=? ORDER BY s.submitted_at`,
      )
      .all(req.params.id),
  );
});
app.put(
  "/api/assignments/:id/submissions/:studentId/grade",
  auth,
  (req, res) => {
    const assignment = db
      .prepare("SELECT * FROM assignments WHERE id=?")
      .get(req.params.id);
    if (!assignment || !canTeach(assignment.classroom_id, req.auth.sub))
      return res
        .status(403)
        .json({ message: "Only a classroom teacher can grade." });
    const grade = Number(req.body.grade);
    if (!Number.isFinite(grade) || grade < 0 || grade > assignment.points)
      return res
        .status(400)
        .json({ message: `Grade must be between 0 and ${assignment.points}.` });
    const result = db.prepare(
      "UPDATE assignment_submissions SET grade=?,feedback=?,graded_at=? WHERE assignment_id=? AND student_id=?",
    ).run(
      grade,
      String(req.body.feedback || ""),
      now(),
      assignment.id,
      req.params.studentId,
    );
    if (!result.changes)
      return res.status(404).json({ message: "Student submission was not found." });
    audit(req, "assignment.graded", "assignment", assignment.id, assignment.classroom_id, { studentId: req.params.studentId, grade });
    res.json({ ok: true });
  },
);
app.get("/api/classrooms/:id/marks", auth, (req, res) => {
  const room = classroomAccess(req.params.id, req.auth.sub);
  if (!room)
    return res.status(403).json({ message: "You do not have access." });
  recordExpiredAssignmentZeros(room.id);
  const target = req.auth.role === "student" ? "AND u.id=?" : "";
  const sql = `SELECT u.id,u.name,u.email,u.identifier,(SELECT COUNT(*) FROM attendance_records ar WHERE ar.classroom_id=? AND ar.user_id=u.id) attendanceTotal,(SELECT COUNT(*) FROM attendance_records ar WHERE ar.classroom_id=? AND ar.user_id=u.id AND ar.status='present') attendancePresent,(SELECT ROUND(AVG(100.0*s.grade/a.points),1) FROM assignment_submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.classroom_id=? AND s.student_id=u.id AND s.grade IS NOT NULL) assignmentAverage FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.classroom_id=? ${target} ORDER BY u.name`;
  const args = [
    room.id,
    room.id,
    room.id,
    room.id,
    ...(req.auth.role === "student" ? [req.auth.sub] : []),
  ];
  res.json(db.prepare(sql).all(...args));
});
app.post("/api/classrooms", auth, (req, res) => {
  if (req.auth.role !== "teacher")
    return res
      .status(403)
      .json({ message: "Only teachers can create classrooms." });
  if (!hasVerifiedFace(req.auth.sub))
    return res
      .status(403)
      .json({
        message: "Complete your face verification before creating a classroom.",
      });
  const name = String(req.body.name || "").trim(),
    subject = String(req.body.subject || "").trim(),
    section = String(req.body.section || "").trim(),
    color = String(req.body.color || "#6c5ce7");
  if (!name || !subject)
    return res
      .status(400)
      .json({ message: "Class name and subject are required." });
  if (!/^#[0-9a-f]{6}$/i.test(color))
    return res.status(400).json({ message: "Choose a valid classroom color." });
  const room = {
    id: randomUUID(),
    teacherId: req.auth.sub,
    name,
    subject,
    section,
    color,
    classCode: classCode(),
    createdAt: now(),
  };
  db.prepare(
    "INSERT INTO classrooms(id,teacher_id,name,subject,section,color,class_code,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    room.id,
    room.teacherId,
    name,
    subject,
    section,
    color,
    room.classCode,
    room.createdAt,
  );
  audit(req, "classroom.created", "classroom", room.id, room.id, { name: room.name, subject: room.subject });
  res.status(201).json({ ...room, memberCount: 0, classroomRole: "owner" });
});
app.post("/api/classrooms/:id/invite", auth, async (req, res) => {
  const room = canTeach(req.params.id, req.auth.sub);
  if (!room) return res.status(404).json({ message: "Classroom not found." });
  const role = String(req.body.role || "student"),
    email = String(req.body.email || "")
      .trim()
      .toLowerCase();
  if (!["student", "teacher"].includes(role))
    return res
      .status(400)
      .json({ message: "Invitation role must be student or teacher." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res
      .status(400)
      .json({ message: "Enter a valid invitation email address." });

  const existingUser = db
    .prepare("SELECT id,role FROM users WHERE lower(email)=?")
    .get(email);
  if (existingUser) {
    const isOwner = room.teacher_id === existingUser.id;
    const isTeacher = Boolean(
      db
        .prepare(
          "SELECT 1 FROM classroom_teachers WHERE classroom_id=? AND teacher_id=?",
        )
        .get(room.id, existingUser.id),
    );
    const isStudent = Boolean(
      db
        .prepare("SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?")
        .get(room.id, existingUser.id),
    );
    if (isOwner || isTeacher || isStudent) {
      const membership = isOwner
        ? "classroom owner"
        : isTeacher
          ? "teacher"
          : "student";
      return res
        .status(409)
        .json({
          message: `This email is already present in the classroom as a ${membership}.`,
        });
    }
    if (existingUser.role !== role)
      return res
        .status(409)
        .json({
          message: `This email belongs to a ${existingUser.role} account and cannot be invited as a ${role}.`,
        });
  }

  const pending = db
    .prepare(
      "SELECT 1 FROM invitations WHERE classroom_id=? AND lower(email)=? AND accepted_at IS NULL AND datetime(expires_at)>datetime('now')",
    )
    .get(room.id, email);
  if (pending)
    return res
      .status(409)
      .json({
        message:
          "An active invitation has already been sent to this email for this classroom.",
      });

  const invite = {
    id: randomUUID(),
    classroomId: room.id,
    email,
    token: randomBytes(24).toString("hex"),
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    role,
  };
  db.prepare(
    "INSERT INTO invitations(id,classroom_id,email,token,expires_at,invitee_role) VALUES(?,?,?,?,?,?)",
  ).run(
    invite.id,
    invite.classroomId,
    invite.email,
    invite.token,
    invite.expiresAt,
    invite.role,
  );
  const delivery = await emailInvite(
    invite,
    room,
    db.prepare("SELECT name FROM users WHERE id=?").get(req.auth.sub),
    req.get("origin"),
  );
  if (existingUser)
    void notifyUser(
      existingUser.id,
      "invitation",
      `Invitation to ${room.name}`,
      `You were invited to join ${room.name} as a ${role}.`,
      delivery.link,
    );
  res.status(201).json({ email: invite.email, role, ...delivery });
});
app.get("/api/invitations/:token", (req, res) => {
  const i = db
    .prepare(
      `SELECT i.email,i.expires_at expiresAt,i.accepted_at acceptedAt,c.name classroomName,c.subject,u.name teacherName FROM invitations i JOIN classrooms c ON c.id=i.classroom_id JOIN users u ON u.id=c.teacher_id WHERE i.token=?`,
    )
    .get(req.params.token);
  if (!i) return res.status(404).json({ message: "Invitation not found." });
  res.json({
    ...i,
    valid: !i.acceptedAt && new Date(i.expiresAt) > new Date(),
  });
});
app.post("/api/invitations/:token/accept", auth, (req, res) => {
  const i = db
      .prepare("SELECT * FROM invitations WHERE token=?")
      .get(req.params.token),
    u = db.prepare("SELECT * FROM users WHERE id=?").get(req.auth.sub);
  if (!i) return res.status(404).json({ message: "Invitation not found." });
  if (!hasVerifiedFace(req.auth.sub))
    return res
      .status(403)
      .json({
        message:
          "Complete your face verification before accepting a classroom invitation.",
      });
  if (u.email !== i.email || u.role !== i.invitee_role)
    return res
      .status(403)
      .json({
        message: `This invitation belongs to another ${i.invitee_role} account.`,
      });
  const joined =
    i.invitee_role === "teacher"
      ? db
          .prepare(
            "SELECT 1 FROM classroom_teachers WHERE classroom_id=? AND teacher_id=?",
          )
          .get(i.classroom_id, u.id)
      : db
          .prepare(
            "SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?",
          )
          .get(i.classroom_id, u.id);
  if (i.accepted_at && joined)
    return res.json({ ok: true, role: i.invitee_role, alreadyAccepted: true });
  if (i.accepted_at || new Date(i.expires_at) < new Date())
    return res
      .status(400)
      .json({ message: "Invitation is invalid or expired." });
  transaction(() => {
    if (i.invitee_role === "teacher")
      db.prepare(
        "INSERT OR IGNORE INTO classroom_teachers(id,classroom_id,teacher_id,joined_at) VALUES(?,?,?,?)",
      ).run(randomUUID(), i.classroom_id, u.id, now());
    else
      db.prepare(
        "INSERT OR IGNORE INTO memberships(id,classroom_id,user_id,joined_at) VALUES(?,?,?,?)",
      ).run(randomUUID(), i.classroom_id, u.id, now());
    db.prepare("UPDATE invitations SET accepted_at=? WHERE id=?").run(
      now(),
      i.id,
    );
  });
  res.json({ ok: true, role: i.invitee_role });
});
app.post("/api/classrooms/:id/sessions", auth, async (req, res) => {
  const room = canTeach(req.params.id, req.auth.sub);
  if (!room) return res.status(404).json({ message: "Classroom not found." });
  const activeSession = db
    .prepare(
      "SELECT id,expires_at FROM attendance_sessions WHERE classroom_id=? AND finalized_at IS NULL AND expires_at>? ORDER BY starts_at DESC LIMIT 1",
    )
    .get(room.id, now());
  if (activeSession)
    return res.status(409).json({
      message: "This classroom already has an active attendance session. Wait for it to expire before creating another.",
      sessionId: activeSession.id,
      expiresAt: activeSession.expires_at,
    });
  const grant = db
    .prepare(
      "SELECT * FROM face_auth_grants WHERE id=? AND user_id=? AND purpose='create-attendance' AND used_at IS NULL AND datetime(expires_at)>datetime('now')",
    )
    .get(req.body.faceGrantId, req.auth.sub);
  if (!grant)
    return res
      .status(403)
      .json({
        message:
          "Verify your face immediately before generating the attendance QR code.",
      });
  const s = {
    id: randomUUID(),
    classroomId: room.id,
    teacherId: req.auth.sub,
    roomNumber: String(req.body.roomNumber || "").trim().slice(0, 100),
    lat: Number(req.body.lat),
    lng: Number(req.body.lng),
    accuracy: Number(req.body.accuracy),
    radius: Number(req.body.radius || 75),
    code: randomBytes(18).toString("hex"),
    startsAt: now(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  if (!s.roomNumber || !Number.isFinite(s.lat) || !Number.isFinite(s.lng))
    return res
      .status(400)
      .json({ message: "Room and teacher location required." });
  if (s.lat < -90 || s.lat > 90 || s.lng < -180 || s.lng > 180)
    return res.status(400).json({ message: "Teacher coordinates are invalid." });
  if (!Number.isFinite(s.radius) || s.radius < 10 || s.radius > 100)
    return res.status(400).json({ message: "Attendance radius must be between 10 and 100 metres." });
  if (!Number.isFinite(s.accuracy) || s.accuracy > 120)
    { securityEvent(req.auth.sub, "gps.teacher_inaccurate", "warning", room.id, { accuracy: s.accuracy });
    return res
      .status(422)
      .json({
        message: `Teacher location is not accurate enough${Number.isFinite(s.accuracy) ? ` (±${Math.round(s.accuracy)} m)` : ""}. Enable precise location and wait for GPS before retrying.`,
      }); }
  transaction(() => {
    db.prepare(
      "INSERT INTO attendance_sessions(id,classroom_id,teacher_id,room_number,latitude,longitude,location_accuracy_meters,radius_meters,code,starts_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      s.id,
      s.classroomId,
      s.teacherId,
      s.roomNumber,
      s.lat,
      s.lng,
      s.accuracy,
      s.radius,
      s.code,
      s.startsAt,
      s.expiresAt,
    );
    db.prepare("UPDATE face_auth_grants SET used_at=? WHERE id=?").run(
      s.startsAt,
      grant.id,
    );
  });
  const payload = JSON.stringify({
    type: "classmark-attendance",
    sessionId: s.id,
    code: s.code,
  });
  res
    .status(201)
    .json({
      ...s,
      qrDataUrl: await QRCode.toDataURL(payload, { width: 480, margin: 2 }),
    });
});
app.post("/api/attendance/check-in", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res.status(403).json({ message: "Only students use QR check-in." });
  if (!hasVerifiedFace(req.auth.sub))
    return res
      .status(403)
      .json({
        message: "Complete your face enrollment before using attendance.",
      });
  const s = db
    .prepare("SELECT * FROM attendance_sessions WHERE id=? AND code=?")
    .get(req.body.sessionId, req.body.code);
  if (!s || s.finalized_at || new Date(s.expires_at) < new Date())
    return res.status(400).json({ message: "QR code expired." });
  if (
    !db
      .prepare("SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?")
      .get(s.classroom_id, req.auth.sub)
  )
    return res.status(403).json({ message: "Not enrolled in this classroom." });
  const accuracy = Number(req.body.accuracy);
  const studentLat = Number(req.body.lat),
    studentLng = Number(req.body.lng);
  if (
    !Number.isFinite(studentLat) ||
    !Number.isFinite(studentLng) ||
    studentLat < -90 ||
    studentLat > 90 ||
    studentLng < -180 ||
    studentLng > 180
  )
    return res.status(400).json({ message: "Student coordinates are invalid." });
  if (!Number.isFinite(accuracy) || accuracy > 120)
    { securityEvent(req.auth.sub, "gps.student_inaccurate", "warning", s.classroom_id, { accuracy });
    return res
      .status(422)
      .json({
        message: `Student location is not accurate enough${Number.isFinite(accuracy) ? ` (±${Math.round(accuracy)} m)` : ""}. Enable precise location and wait for GPS before retrying.`,
      }); }
  const d = distance(
    { lat: s.latitude, lng: s.longitude },
    { lat: studentLat, lng: studentLng },
  );
  if (!Number.isFinite(d) || d > s.radius_meters)
    { securityEvent(req.auth.sub, "gps.outside_radius", d > s.radius_meters * 5 ? "critical" : "warning", s.classroom_id, { distance: d, radius: s.radius_meters, accuracy });
    return res
      .status(403)
      .json({
        message: `Reliable GPS readings place you ${Math.round(d)} m away; allowed radius is ${s.radius_meters} m. Teacher accuracy: ±${Math.round(s.location_accuracy_meters || 0)} m, student accuracy: ±${Math.round(accuracy)} m.`,
      }); }
  const recorded = now(),
    existing = db
      .prepare(
        "SELECT * FROM attendance_records WHERE session_id=? AND user_id=?",
      )
      .get(s.id, req.auth.sub),
    faceVerified = Boolean(existing?.face_verified_at),
    status = faceVerified ? "present" : "absent",
    reason = faceVerified
      ? "QR, location, and face verified."
      : "QR and location verified; face authentication is still required.";
  db.prepare(
    `INSERT INTO attendance_records(id,session_id,classroom_id,user_id,method,distance_meters,location_accuracy_meters,status,recorded_at,qr_verified_at,face_verified_at,face_event_id,decision_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,user_id) DO UPDATE SET method=CASE WHEN attendance_records.face_verified_at IS NULL THEN 'qr' ELSE 'qr+face' END,distance_meters=excluded.distance_meters,location_accuracy_meters=excluded.location_accuracy_meters,qr_verified_at=excluded.qr_verified_at,status=excluded.status,decision_reason=excluded.decision_reason`,
  ).run(
    randomUUID(),
    s.id,
    s.classroom_id,
    req.auth.sub,
    faceVerified ? "qr+face" : "qr",
    Math.round(d),
    accuracy,
    status,
    existing?.recorded_at || recorded,
    recorded,
    existing?.face_verified_at || null,
    existing?.face_event_id || null,
    reason,
  );
  res
    .status(existing ? 200 : 201)
    .json({
      status,
      decision: status === "present" ? "complete" : "pending-face",
      sessionId: s.id,
      distance: Math.round(d),
      accuracy: Math.round(accuracy),
      alreadyRecorded: Boolean(existing),
      message: reason,
    });
});

function faceImageBytes(image) {
  const match = String(image || "").match(
    /^data:image\/(?:jpeg|png|webp);base64,(.+)$/,
  );
  if (!match) throw new Error("A JPEG, PNG, or WebP camera image is required.");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > 5_000_000)
    throw new Error("Face image must be between 1 byte and 5 MB.");
  return bytes;
}
app.post("/api/admin/auth/session", auth, async (req, res) => {
  if (req.auth.role !== "admin")
    return res.status(403).json({ message: "Administrator access is required." });
  if (!hasVerifiedFace(req.auth.sub))
    return res.status(403).json({
      message: "Complete mandatory administrator face enrollment first.",
    });
  if (!faceConfig.backendConfigured || !faceConfig.browserConfigured)
    return res.status(503).json({
      message: "AWS live face authentication is not fully configured.",
    });
  try {
    const created = await createLivenessSession(randomUUID()),
      createdAt = now(),
      expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    db.prepare(
      "INSERT INTO admin_login_face_sessions(id,user_id,aws_session_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      req.auth.sub,
      created.SessionId,
      "created",
      createdAt,
      expiresAt,
    );
    res.status(201).json({
      sessionId: created.SessionId,
      region: faceConfig.region,
      identityPoolId: faceConfig.identityPoolId,
      challengeMode:
        faceConfig.livenessChallenge === "FaceMovementChallenge"
          ? "movement"
          : "movement-and-light",
      expiresAt,
    });
  } catch (error) {
    console.error("[administrator live authentication session]", error);
    res.status(502).json({
      message: `AWS could not start administrator verification: ${error.message || error.name}`,
    });
  }
});
app.post("/api/admin/auth/complete", auth, async (req, res) => {
  if (req.auth.role !== "admin")
    return res.status(403).json({ message: "Administrator access is required." });
  const verification = db
    .prepare(
      "SELECT * FROM admin_login_face_sessions WHERE aws_session_id=? AND user_id=?",
    )
    .get(req.body.sessionId, req.auth.sub);
  if (!verification)
    return res.status(404).json({ message: "Administrator face check was not found." });
  if (verification.status === "succeeded")
    return res.status(409).json({ message: "This face check was already used." });
  if (new Date(verification.expires_at) < new Date()) {
    db.prepare(
      "UPDATE admin_login_face_sessions SET status='expired',completed_at=? WHERE id=?",
    ).run(now(), verification.id);
    return res.status(410).json({ message: "The face check expired. Start again." });
  }
  try {
    db.prepare(
      "UPDATE admin_login_face_sessions SET status='processing' WHERE id=?",
    ).run(verification.id);
    const liveness = await getLivenessResult(verification.aws_session_id),
      livenessConfidence = Number(liveness.Confidence || 0),
      referenceImage = liveness.ReferenceImage?.Bytes
        ? Buffer.from(liveness.ReferenceImage.Bytes)
        : null;
    if (
      liveness.Status !== "SUCCEEDED" ||
      livenessConfidence < faceConfig.livenessThreshold ||
      !referenceImage?.length
    )
      throw new Error("Live person verification was not successful.");
    const matches = await identifyFace(referenceImage),
      match = matches.find(
        (item) => item.User?.UserId === providerUserId(req.auth.sub),
      );
    if (!match || Number(match.Similarity || 0) < faceConfig.matchThreshold)
      throw new Error("The live face does not match this administrator account.");
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.auth.sub),
      completedAt = now();
    db.prepare(
      "UPDATE admin_login_face_sessions SET status='succeeded',completed_at=? WHERE id=?",
    ).run(completedAt, verification.id);
    audit(req, "admin.login_face_verified", "user", user.id, null, {
      livenessConfidence,
      matchConfidence: Number(match.Similarity || 0),
    });
    res.json({
      token: tokenFor(user, true),
      user: { ...publicUser(user), adminFaceAuthenticated: true },
      message: "Administrator identity verified.",
    });
  } catch (error) {
    db.prepare(
      "UPDATE admin_login_face_sessions SET status='failed',completed_at=? WHERE id=?",
    ).run(now(), verification.id);
    securityEvent(req.auth.sub, "admin.face_login_failed", "critical", null, {
      message: error.message,
    });
    res.status(422).json({
      message:
        error.message || "Administrator live face verification failed.",
    });
  }
});
app.post("/api/faces/authentication/session", auth, async (req, res) => {
  if (!faceConfig.backendConfigured || !faceConfig.browserConfigured)
    return res.status(503).json({
      message:
        "AWS live face authentication is not fully configured on the server.",
    });
  if (!hasVerifiedFace(req.auth.sub))
    return res.status(403).json({
      message: "Complete first-time face enrollment before authenticating.",
    });
  const purpose = req.body.purpose;
  if (purpose === "create-attendance" && req.auth.role !== "teacher")
    return res.status(403).json({ message: "Teacher access is required." });
  if (purpose === "attendance") {
    if (req.auth.role !== "student")
      return res.status(403).json({ message: "Student access is required." });
    const attendanceSession = db
        .prepare("SELECT * FROM attendance_sessions WHERE id=?")
        .get(req.body.attendanceSessionId),
      record =
        attendanceSession &&
        db
          .prepare(
            "SELECT * FROM attendance_records WHERE session_id=? AND user_id=?",
          )
          .get(attendanceSession.id, req.auth.sub);
    if (
      !attendanceSession ||
      attendanceSession.finalized_at ||
      new Date(attendanceSession.expires_at) < new Date()
    )
      return res
        .status(409)
        .json({ message: "This attendance session is no longer active." });
    if (!record?.qr_verified_at)
      return res.status(403).json({
        message: "QR and location verification must be completed first.",
      });
  } else if (purpose !== "create-attendance") {
    return res.status(400).json({ message: "Invalid authentication purpose." });
  }
  try {
    const created = await createLivenessSession(randomUUID()),
      createdAt = now(),
      expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    db.prepare(
      "INSERT INTO face_verification_sessions(id,user_id,aws_session_id,purpose,attendance_session_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      req.auth.sub,
      created.SessionId,
      purpose,
      req.body.attendanceSessionId || null,
      "created",
      createdAt,
      expiresAt,
    );
    res.status(201).json({
      sessionId: created.SessionId,
      region: faceConfig.region,
      identityPoolId: faceConfig.identityPoolId,
      challengeMode:
        faceConfig.livenessChallenge === "FaceMovementChallenge"
          ? "movement"
          : "movement-and-light",
      expiresAt,
    });
  } catch (error) {
    console.error("[live authentication session]", error);
    res.status(502).json({
      message: `AWS could not start live face authentication: ${error.message || error.name}`,
    });
  }
});

app.post("/api/faces/authentication/complete", auth, async (req, res) => {
  const verification = db
    .prepare(
      "SELECT * FROM face_verification_sessions WHERE aws_session_id=? AND user_id=?",
    )
    .get(req.body.sessionId, req.auth.sub);
  if (!verification)
    return res
      .status(404)
      .json({ message: "Live authentication session was not found." });
  if (verification.status === "succeeded")
    return res.status(409).json({ message: "This live check was already used." });
  if (new Date(verification.expires_at) < new Date()) {
    db.prepare(
      "UPDATE face_verification_sessions SET status='expired',completed_at=? WHERE id=?",
    ).run(now(), verification.id);
    return res
      .status(410)
      .json({ message: "The live face check expired. Start again." });
  }
  const identityFailure =
    verification.purpose === "create-attendance"
      ? "The live person was not recognized as the signed-in teacher. Try again with your full face clearly visible."
      : "The live person was not recognized as the signed-in student. Try again, or request teacher review.";
  try {
    db.prepare(
      "UPDATE face_verification_sessions SET status='processing' WHERE id=?",
    ).run(verification.id);
    const liveness = await getLivenessResult(verification.aws_session_id),
      livenessConfidence = Number(liveness.Confidence || 0),
      referenceImage = liveness.ReferenceImage?.Bytes
        ? Buffer.from(liveness.ReferenceImage.Bytes)
        : null;
    if (
      liveness.Status !== "SUCCEEDED" ||
      livenessConfidence < faceConfig.livenessThreshold ||
      !referenceImage?.length
    ) {
      db.prepare(
        "UPDATE face_verification_sessions SET status='failed',completed_at=? WHERE id=?",
      ).run(now(), verification.id);
      securityEvent(req.auth.sub, "face.liveness_failed", "warning", null, { purpose: verification.purpose, confidence: livenessConfidence, status: liveness.Status });
      return res.status(422).json({
        message:
          "Live person verification failed. Photos, screens, objects, partial faces, and poorly visible faces are not accepted. Use even light and follow the movement prompt.",
      });
    }
    const matches = await identifyFace(referenceImage),
      match = matches.find(
        (item) => item.User?.UserId === providerUserId(req.auth.sub),
      );
    if (!match || Number(match.Similarity || 0) < faceConfig.matchThreshold) {
      db.prepare(
        "UPDATE face_verification_sessions SET status='failed',completed_at=? WHERE id=?",
      ).run(now(), verification.id);
      securityEvent(req.auth.sub, "face.identity_mismatch", "critical", null, { purpose: verification.purpose, similarity: Number(match?.Similarity || 0) });
      return res.status(422).json({ message: identityFailure });
    }
    const completedAt = now(),
      profilePictureSaved = saveProfilePictureIfMissing(
        req.auth.sub,
        referenceImage,
      );
    if (verification.purpose === "create-attendance") {
      const grant = {
        id: randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      transaction(() => {
        db.prepare(
          "INSERT INTO face_auth_grants(id,user_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?)",
        ).run(
          grant.id,
          req.auth.sub,
          "create-attendance",
          completedAt,
          grant.expiresAt,
        );
        db.prepare(
          "UPDATE face_verification_sessions SET status='succeeded',completed_at=? WHERE id=?",
        ).run(completedAt, verification.id);
      });
      return res.json({
        verified: true,
        faceGrantId: grant.id,
        expiresAt: grant.expiresAt,
        livenessConfidence,
        matchConfidence: Number(match.Similarity || 0),
        profilePictureSaved,
        message: "Live teacher identity confirmed. You may generate the QR code.",
      });
    }
    const attendanceSession = db
        .prepare("SELECT * FROM attendance_sessions WHERE id=?")
        .get(verification.attendance_session_id),
      record =
        attendanceSession &&
        db
          .prepare(
            "SELECT * FROM attendance_records WHERE session_id=? AND user_id=?",
          )
          .get(attendanceSession.id, req.auth.sub);
    if (
      !attendanceSession ||
      attendanceSession.finalized_at ||
      new Date(attendanceSession.expires_at) < new Date() ||
      !record?.qr_verified_at
    )
      return res.status(409).json({
        message: "The QR attendance session ended before face verification.",
      });
    transaction(() => {
      db.prepare(
        "UPDATE attendance_records SET method='qr+face+liveness',face_verified_at=?,status='present',decision_reason='QR, location, AWS liveness, and identity match verified.' WHERE id=?",
      ).run(completedAt, record.id);
      db.prepare(
        "UPDATE face_verification_sessions SET status='succeeded',completed_at=? WHERE id=?",
      ).run(completedAt, verification.id);
    });
    return res.json({
      verified: true,
      decision: "complete",
      classroomId: attendanceSession.classroom_id,
      livenessConfidence,
      matchConfidence: Number(match.Similarity || 0),
      profilePictureSaved,
      message:
        "Attendance complete. QR, location, live-person check, and identity were verified.",
    });
  } catch (error) {
    db.prepare(
      "UPDATE face_verification_sessions SET status='failed',completed_at=? WHERE id=?",
    ).run(now(), verification.id);
    console.error("[live authentication complete]", error);
    res.status(502).json({
      message: `AWS could not complete live authentication: ${error.message || error.name}`,
    });
  }
});

app.post("/api/faces/authenticate", auth, async (req, res) => {
  return res.status(410).json({
    message:
      "Still-image authentication has been disabled. Complete the AWS live face check instead.",
  });
  /* c8 ignore start */
  // eslint-disable-next-line no-unreachable
  let bytes;
  const noMatchMessage =
    req.body.purpose === "create-attendance"
      ? "Teacher identity could not be confirmed. Show your own face clearly to the front camera and try again before generating the QR code."
      : "Student identity could not be confirmed. Show your own face clearly to the front camera and try again. If verification continues to fail after QR and location approval, request manual review from your teacher.";
  try {
    bytes = faceImageBytes(req.body.image);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  try {
    const matches = await identifyFace(bytes),
      match = matches.find(
        (item) => item.User?.UserId === providerUserId(req.auth.sub),
      );
    if (!match)
      return res
        .status(422)
        .json({ message: noMatchMessage });
    const at = now(),
      profilePictureSaved = saveProfilePictureIfMissing(
        req.auth.sub,
        bytes,
      );
    if (req.body.purpose === "create-attendance") {
      if (req.auth.role !== "teacher")
        return res
          .status(403)
          .json({ message: "Only teachers can authorize QR generation." });
      const grant = {
        id: randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      db.prepare(
        "INSERT INTO face_auth_grants(id,user_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?)",
      ).run(grant.id, req.auth.sub, "create-attendance", at, grant.expiresAt);
      return res.json({
        verified: true,
        faceGrantId: grant.id,
        expiresAt: grant.expiresAt,
        profilePictureSaved,
        message: "Identity confirmed. You may generate the QR code now.",
      });
    }
    if (req.body.purpose === "attendance") {
      if (req.auth.role !== "student")
        return res
          .status(403)
          .json({ message: "Only students complete QR attendance this way." });
      const session = db
          .prepare("SELECT * FROM attendance_sessions WHERE id=?")
          .get(req.body.sessionId),
        record =
          session &&
          db
            .prepare(
              "SELECT * FROM attendance_records WHERE session_id=? AND user_id=?",
            )
            .get(session.id, req.auth.sub);
      if (
        !session ||
        session.finalized_at ||
        new Date(session.expires_at) < new Date()
      )
        return res
          .status(409)
          .json({ message: "This attendance session is no longer active." });
      if (!record?.qr_verified_at)
        return res
          .status(403)
          .json({
            message: "Scan the QR code and pass location verification first.",
          });
      db.prepare(
        "UPDATE attendance_records SET method='qr+face',face_verified_at=?,status='present',decision_reason='QR, location, and self-face authentication verified.' WHERE id=?",
      ).run(at, record.id);
      return res.json({
        verified: true,
        decision: "complete",
        classroomId: session.classroom_id,
        profilePictureSaved,
        message: "Attendance complete. QR, location, and face were verified.",
      });
    }
    return res
      .status(400)
      .json({ message: "Unknown face authentication purpose." });
  } catch (error) {
    console.error("[self face authentication]", error);
    if (error.name === "InvalidParameterException")
      return res.status(422).json({ message: noMatchMessage });
    res
      .status(502)
      .json({
        message: `Face authentication service failed: ${error.message || error.name}`,
      });
  }
  /* c8 ignore stop */
});
app.post("/api/attendance/review-requests", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res
      .status(403)
      .json({ message: "Only students can request attendance review." });
  const session = db
      .prepare("SELECT * FROM attendance_sessions WHERE id=?")
      .get(req.body.sessionId),
    record =
      session &&
      db
        .prepare(
          "SELECT * FROM attendance_records WHERE session_id=? AND user_id=?",
        )
        .get(session.id, req.auth.sub);
  if (
    !session ||
    session.finalized_at ||
    new Date(session.expires_at) < new Date()
  )
    return res
      .status(409)
      .json({ message: "This attendance session is no longer active." });
  if (!record?.qr_verified_at)
    return res
      .status(403)
      .json({
        message:
          "QR and location verification are required before manual review.",
      });
  if (record.status === "present")
    return res
      .status(409)
      .json({ message: "Your attendance is already complete." });
  const request = {
    id: randomUUID(),
    reason: String(
      req.body.reason || "Face authentication could not be completed.",
    ).slice(0, 500),
    requestedAt: now(),
  };
  db.prepare(
    `INSERT INTO attendance_review_requests(id,session_id,user_id,reason,requested_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id,user_id) DO UPDATE SET reason=excluded.reason,status='pending',requested_at=excluded.requested_at,resolved_by=NULL,resolved_at=NULL,resolution_note=''`,
  ).run(
    request.id,
    session.id,
    req.auth.sub,
    request.reason,
    request.requestedAt,
  );
  const student = db
      .prepare("SELECT name FROM users WHERE id=?")
      .get(req.auth.sub),
    room = db
      .prepare("SELECT name FROM classrooms WHERE id=?")
      .get(session.classroom_id);
  for (const teacherId of classroomTeacherIds(session.classroom_id))
    void notifyUser(
      teacherId,
      "attendance",
      `Manual attendance review: ${student.name}`,
      `${student.name} requested verification for ${room.name}.`,
      "/?page=attendance",
      true,
    );
  res
    .status(201)
    .json({
      ok: true,
      message:
        "Manual verification requested. A classroom teacher has been notified.",
    });
});
app.get("/api/attendance/review-requests", auth, (req, res) => {
  if (req.auth.role !== "teacher")
    return res
      .status(403)
      .json({ message: "Only teachers can view attendance reviews." });
  res.json(
    db
      .prepare(
        `SELECT r.id,r.session_id sessionId,r.reason,r.status,r.requested_at requestedAt,u.name studentName,u.identifier,c.name classroomName FROM attendance_review_requests r JOIN attendance_sessions s ON s.id=r.session_id JOIN classrooms c ON c.id=s.classroom_id JOIN users u ON u.id=r.user_id LEFT JOIN classroom_teachers ct ON ct.classroom_id=c.id WHERE (c.teacher_id=? OR ct.teacher_id=?) AND r.status='pending' GROUP BY r.id ORDER BY r.requested_at DESC`,
      )
      .all(req.auth.sub, req.auth.sub),
  );
});
app.patch("/api/attendance/review-requests/:id", auth, (req, res) => {
  if (req.auth.role !== "teacher")
    return res
      .status(403)
      .json({ message: "Only teachers can resolve attendance reviews." });
  const request = db
    .prepare(
      `SELECT r.*,s.classroom_id FROM attendance_review_requests r JOIN attendance_sessions s ON s.id=r.session_id WHERE r.id=?`,
    )
    .get(req.params.id);
  if (!request || !canTeach(request.classroom_id, req.auth.sub))
    return res.status(404).json({ message: "Review request not found." });
  const decision = req.body.decision;
  if (!["approved", "rejected"].includes(decision))
    return res
      .status(400)
      .json({ message: "Decision must be approved or rejected." });
  const at = now(),
    note = String(req.body.note || "").slice(0, 500);
  transaction(() => {
    db.prepare(
      "UPDATE attendance_review_requests SET status=?,resolved_by=?,resolved_at=?,resolution_note=? WHERE id=?",
    ).run(decision, req.auth.sub, at, note, request.id);
    if (decision === "approved")
      db.prepare(
        "UPDATE attendance_records SET method='qr+manual',status='present',decision_reason='QR and location verified; face exception approved manually by teacher.' WHERE session_id=? AND user_id=?",
      ).run(request.session_id, request.user_id);
  });
  audit(req, `attendance.manual_review_${decision}`, "attendance_record", request.session_id, request.classroom_id, { studentId: request.user_id, note });
  void notifyUser(
    request.user_id,
    "attendance",
    `Attendance review ${decision}`,
    decision === "approved"
      ? "Your teacher approved the manual attendance verification."
      : "Your teacher rejected the manual attendance verification.",
    `/?page=classes&classroomId=${request.classroom_id}&tab=marks`,
  );
  res.json({ ok: true, status: decision });
});
app.get("/api/faces/status", auth, (req, res) => {
  const profile = db
    .prepare(
      "SELECT provider,collection_id,provider_user_id,status,consent_at,enrolled_at,last_verified_at,revoked_at FROM face_profiles WHERE user_id=?",
    )
    .get(req.auth.sub);
  res.json({
    configured: faceConfig.backendConfigured && faceConfig.browserConfigured,
    backendConfigured: faceConfig.backendConfigured,
    browserConfigured: faceConfig.browserConfigured,
    region: faceConfig.region,
    identityPoolId: faceConfig.identityPoolId,
    collectionId: faceConfig.collectionId,
    challengeMode:
      faceConfig.livenessChallenge === "FaceMovementChallenge"
        ? "movement"
        : "movement-and-light",
    profile: profile
      ? {
          ...profile,
          verified: profile.status === "verified" && !profile.revoked_at,
        }
      : null,
  });
});
app.post("/api/faces/liveness/session", auth, async (req, res) => {
  if (!faceConfig.backendConfigured || !faceConfig.browserConfigured)
    return res
      .status(503)
      .json({
        message:
          "AWS face enrollment is not fully configured. Set the collection and Cognito Identity Pool values.",
      });
  if (req.body.consent !== true)
    return res
      .status(400)
      .json({
        message: "Biometric consent is required before face enrollment.",
      });
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.auth.sub);
  const identifierRequired = user?.role === "teacher" || user?.role === "student";
  if (!user?.name || (identifierRequired && !user.identifier))
    return res
      .status(400)
      .json({
        message: `Complete your name${user?.role === "teacher" ? " and faculty ID" : user?.role === "student" ? " and student enrollment ID" : ""} before enrolling your face.`,
      });
  const current = db
    .prepare(
      "SELECT 1 FROM face_profiles WHERE user_id=? AND status='verified' AND revoked_at IS NULL",
    )
    .get(user.id);
  if (current)
    return res
      .status(409)
      .json({
        message:
          "A verified face profile already exists. Delete it before re-enrolling.",
      });
  try {
    const created = await createLivenessSession(randomUUID());
    const at = now(),
      expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    db.prepare(
      "INSERT INTO face_enrollment_sessions(id,user_id,aws_session_id,status,consent_at,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      user.id,
      created.SessionId,
      "created",
      at,
      at,
      expiresAt,
    );
    res
      .status(201)
      .json({
        sessionId: created.SessionId,
        region: faceConfig.region,
        identityPoolId: faceConfig.identityPoolId,
        challengeMode:
          faceConfig.livenessChallenge === "FaceMovementChallenge"
            ? "movement"
            : "movement-and-light",
        expiresAt,
      });
  } catch (error) {
    console.error("[face liveness session]", error);
    res
      .status(502)
      .json({
        message: `AWS could not start face enrollment: ${error.name || error.message}`,
      });
  }
});
app.post("/api/faces/liveness/complete", auth, async (req, res) => {
  const enrollment = db
    .prepare(
      "SELECT * FROM face_enrollment_sessions WHERE aws_session_id=? AND user_id=?",
    )
    .get(req.body.sessionId, req.auth.sub);
  if (!enrollment)
    return res
      .status(404)
      .json({ message: "Face enrollment session not found." });
  if (enrollment.status === "succeeded")
    return res.json({
      verified: true,
      message: "Face profile is already verified.",
    });
  if (new Date(enrollment.expires_at) < new Date()) {
    db.prepare(
      "UPDATE face_enrollment_sessions SET status='expired',completed_at=? WHERE id=?",
    ).run(now(), enrollment.id);
    return res
      .status(410)
      .json({ message: "Face enrollment session expired. Start again." });
  }
  try {
    db.prepare(
      "UPDATE face_enrollment_sessions SET status='processing' WHERE id=?",
    ).run(enrollment.id);
    const result = await getLivenessResult(enrollment.aws_session_id),
      confidence = Number(result.Confidence || 0),
      feedback = (result.Feedback || [])
        .map((item) => item.Message)
        .filter(Boolean),
      guidance = feedback.length
        ? feedback.join(" ")
        : "Keep your full face inside the oval, look directly at the camera, and move closer when prompted.";
    if (
      result.Status !== "SUCCEEDED" ||
      confidence < faceConfig.livenessThreshold
    ) {
      db.prepare(
        "UPDATE face_enrollment_sessions SET status='failed',completed_at=? WHERE id=?",
      ).run(now(), enrollment.id);
      return res
        .status(422)
        .json({
          message: `The live face check could not be confirmed. ${guidance}`,
        });
    }
    const enrolled = await enrollReferenceImage(
        req.auth.sub,
        result.ReferenceImage?.Bytes,
      ),
      at = now();
    const referenceImage = result.ReferenceImage?.Bytes
      ? Buffer.from(result.ReferenceImage.Bytes)
      : null;
    transaction(() => {
      db.prepare("DELETE FROM face_profiles WHERE user_id=?").run(req.auth.sub);
      db.prepare(
        "INSERT INTO face_profiles(id,user_id,image,image_type,status,enrolled_at,provider,collection_id,provider_user_id,face_ids,consent_at,last_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        req.auth.sub,
        Buffer.alloc(0),
        "application/x-rekognition-vector",
        "verified",
        at,
        "aws-rekognition",
        faceConfig.collectionId,
        enrolled.awsUserId,
        JSON.stringify(enrolled.faceIds),
        enrollment.consent_at,
        at,
      );
      db.prepare(
        "UPDATE face_enrollment_sessions SET status='succeeded',completed_at=? WHERE id=?",
      ).run(at, enrollment.id);
      saveProfilePictureIfMissing(req.auth.sub, referenceImage);
    });
    res.json({
      verified: true,
      message: "Live face verified. Your Rekognition face profile is ready.",
    });
  } catch (error) {
    db.prepare(
      "UPDATE face_enrollment_sessions SET status='failed',completed_at=? WHERE id=?",
    ).run(now(), enrollment.id);
    console.error("[face enrollment complete]", error);
    const configurationError = [
      "AccessDeniedException",
      "UnrecognizedClientException",
      "InvalidSignatureException",
      "ResourceNotFoundException",
    ].includes(error.name);
    res
      .status(502)
      .json({
        message: configurationError
          ? "Face verification reached AWS, but the server configuration or IAM permissions are incomplete. Ask the administrator to check the server logs."
          : `AWS could not finish face enrollment: ${error.message || error.name}`,
      });
  }
});
app.delete("/api/faces/profile", auth, async (req, res) => {
  const profile = db
    .prepare("SELECT * FROM face_profiles WHERE user_id=?")
    .get(req.auth.sub);
  if (!profile)
    return res.status(404).json({ message: "No face profile exists." });
  try {
    await deleteEnrollment(
      profile.provider_user_id,
      JSON.parse(profile.face_ids || "[]"),
    );
    db.prepare("DELETE FROM face_profiles WHERE user_id=?").run(req.auth.sub);
    res.json({
      ok: true,
      message:
        "Your Rekognition face vectors and local profile mapping were deleted.",
    });
  } catch (error) {
    console.error("[face profile delete]", error);
    res
      .status(502)
      .json({
        message: `AWS could not delete the face profile: ${error.name || error.message}`,
      });
  }
});
app.post("/api/sessions/:id/finalize", auth, (req, res) => {
  const s = db
    .prepare("SELECT * FROM attendance_sessions WHERE id=? AND teacher_id=?")
    .get(req.params.id, req.auth.sub);
  if (!s) return res.status(404).json({ message: "Session not found." });
  const result = finalizeAttendanceSession(s);
  res.json({
    finalized: result.finalized,
    message: result.finalized
      ? "Attendance finalized successfully."
      : "Attendance was already finalized.",
    records: result.records,
  });
});
app.get("/api/attendance", auth, (req, res) => {
  const records =
    req.auth.role === "teacher"
      ? db
          .prepare(
            `SELECT a.*,u.name userName,c.name classroomName,s.room_number roomNumber FROM attendance_records a JOIN users u ON u.id=a.user_id JOIN classrooms c ON c.id=a.classroom_id JOIN attendance_sessions s ON s.id=a.session_id WHERE c.teacher_id=? OR EXISTS(SELECT 1 FROM classroom_teachers ct WHERE ct.classroom_id=c.id AND ct.teacher_id=?) ORDER BY a.recorded_at DESC LIMIT 100`,
          )
          .all(req.auth.sub, req.auth.sub)
      : db
          .prepare(
            `SELECT a.*,c.name classroomName,s.room_number roomNumber FROM attendance_records a JOIN classrooms c ON c.id=a.classroom_id JOIN attendance_sessions s ON s.id=a.session_id WHERE a.user_id=? ORDER BY a.recorded_at DESC LIMIT 100`,
          )
          .all(req.auth.sub);
  res.json(records);
});

app.get("/api/schedules", auth, (req, res) => {
  const rows = req.auth.role === "teacher"
    ? db.prepare(`SELECT s.*,c.name classroomName,c.subject,c.color FROM class_schedules s JOIN classrooms c ON c.id=s.classroom_id LEFT JOIN classroom_teachers ct ON ct.classroom_id=c.id WHERE (c.teacher_id=? OR ct.teacher_id=?) AND c.archived_at IS NULL GROUP BY s.id ORDER BY s.weekday,s.start_time`).all(req.auth.sub, req.auth.sub)
    : db.prepare(`SELECT s.*,c.name classroomName,c.subject,c.color FROM class_schedules s JOIN classrooms c ON c.id=s.classroom_id JOIN memberships m ON m.classroom_id=c.id WHERE m.user_id=? AND c.archived_at IS NULL ORDER BY s.weekday,s.start_time`).all(req.auth.sub);
  res.json(rows);
});
app.post("/api/classrooms/:id/schedules", auth, (req, res) => {
  if (!canTeach(req.params.id, req.auth.sub))
    return res.status(403).json({ message: "Only classroom teachers can create schedules." });
  const weekday = Number(req.body.weekday),
    startTime = String(req.body.startTime || ""),
    endTime = String(req.body.endTime || "");
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || endTime <= startTime)
    return res.status(400).json({ message: "Choose a valid weekday and time range." });
  const conflict = db
    .prepare(
      "SELECT 1 FROM class_schedules WHERE classroom_id=? AND weekday=? AND start_time<? AND end_time>?",
    )
    .get(req.params.id, weekday, endTime, startTime);
  if (conflict)
    return res.status(409).json({
      message: "This classroom already has an overlapping schedule on that day.",
    });
  const id = randomUUID();
  db.prepare("INSERT INTO class_schedules(id,classroom_id,weekday,start_time,end_time,room_number,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, req.params.id, weekday, startTime, endTime, String(req.body.roomNumber || ""), req.auth.sub, now());
  audit(req, "schedule.created", "schedule", id, req.params.id, { weekday, startTime, endTime });
  res.status(201).json({ id });
});
app.delete("/api/schedules/:id", auth, (req, res) => {
  const schedule = db.prepare("SELECT * FROM class_schedules WHERE id=?").get(req.params.id);
  if (!schedule || !canTeach(schedule.classroom_id, req.auth.sub))
    return res.status(403).json({ message: "Only classroom teachers can delete schedules." });
  db.prepare("DELETE FROM class_schedules WHERE id=?").run(schedule.id);
  audit(req, "schedule.deleted", "schedule", schedule.id, schedule.classroom_id);
  res.json({ ok: true });
});

function attendanceReportRows(user, query) {
  const conditions = [], params = [];
  if (query.classroomId) { conditions.push("a.classroom_id=?"); params.push(query.classroomId); }
  if (query.from) { conditions.push("date(a.recorded_at)>=date(?)"); params.push(query.from); }
  if (query.to) { conditions.push("date(a.recorded_at)<=date(?)"); params.push(query.to); }
  if (user.role === "student") { conditions.push("a.user_id=?"); params.push(user.sub); }
  else if (user.role === "teacher") {
    conditions.push("(c.teacher_id=? OR EXISTS(SELECT 1 FROM classroom_teachers ct WHERE ct.classroom_id=c.id AND ct.teacher_id=?))");
    params.push(user.sub, user.sub);
  }
  return db.prepare(`SELECT a.id,a.recorded_at recordedAt,a.status,a.method,a.distance_meters distanceMeters,a.location_accuracy_meters locationAccuracy,u.name studentName,u.identifier,c.name classroomName,c.subject,s.room_number roomNumber FROM attendance_records a JOIN users u ON u.id=a.user_id JOIN classrooms c ON c.id=a.classroom_id JOIN attendance_sessions s ON s.id=a.session_id WHERE ${conditions.length ? conditions.join(" AND ") : "1=1"} ORDER BY a.recorded_at DESC`).all(...params);
}
function reportsOnly(req, res, next) {
  if (req.auth.role !== "teacher" && req.auth.role !== "admin")
    return res.status(403).json({ message: "Attendance reports are available to teachers and administrators only." });
  next();
}
app.get("/api/reports/attendance", auth, reportsOnly, (req, res) => res.json(attendanceReportRows(req.auth, req.query)));
app.get("/api/reports/attendance.csv", auth, reportsOnly, (req, res) => {
  const rows = attendanceReportRows(req.auth, req.query),
    columns = [["Date","recordedAt"],["Classroom","classroomName"],["Subject","subject"],["Student","studentName"],["Student ID","identifier"],["Status","status"],["Method","method"],["Distance (m)","distanceMeters"],["GPS accuracy (m)","locationAccuracy"],["Room","roomNumber"]],
    quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns.map(([label]) => quote(label)).join(","), ...rows.map((row) => columns.map(([,key]) => quote(row[key])).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=classmark-attendance.csv");
  res.send(`\uFEFF${csv}`);
});
app.get("/api/reports/attendance.pdf", auth, reportsOnly, (req, res) => {
  const rows = attendanceReportRows(req.auth, req.query), doc = new PDFDocument({ margin: 42, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=classmark-attendance.pdf");
  doc.pipe(res);
  doc.fontSize(20).fillColor("#24322d").text("Classmark attendance report");
  doc.moveDown(.3).fontSize(9).fillColor("#67736e").text(`Generated ${new Date().toLocaleString("en-IN")} | ${rows.length} records`);
  doc.moveDown();
  for (const row of rows) {
    if (doc.y > 745) doc.addPage();
    doc.fontSize(10).fillColor("#17221d").text(`${row.studentName} (${row.identifier || "No ID"})`, { continued: true }).fillColor(row.status === "present" ? "#23805c" : "#b54949").text(`  ${String(row.status).toUpperCase()}`);
    doc.fontSize(8).fillColor("#6f7a75").text(`${row.classroomName} - ${row.subject} | ${new Date(row.recordedAt).toLocaleString("en-IN")} | ${row.method || "Not recorded"}`);
    doc.moveDown(.55).strokeColor("#e3e9e5").moveTo(42, doc.y).lineTo(553, doc.y).stroke().moveDown(.55);
  }
  doc.end();
});

app.get("/api/attendance/mine", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res.status(403).json({ message: "Student access is required." });
  res.json(attendanceReportRows(req.auth, req.query));
});

app.post("/api/attendance/:recordId/corrections", auth, (req, res) => {
  if (req.auth.role !== "student")
    return res.status(403).json({ message: "Only students can request an attendance correction." });
  const record = db.prepare("SELECT * FROM attendance_records WHERE id=?").get(req.params.recordId);
  if (!record || record.user_id !== req.auth.sub || !classroomAccess(record.classroom_id, req.auth.sub))
    return res.status(404).json({ message: "Attendance record not found." });
  if (record.status !== "absent")
    return res.status(409).json({ message: "Only an absent attendance result can be disputed." });
  const requestedStatus = "present", reason = String(req.body.reason || "").trim();
  if (reason.length < 10)
    return res.status(400).json({ message: "Provide a clear reason of at least 10 characters." });
  const pending = db.prepare("SELECT 1 FROM attendance_corrections WHERE record_id=? AND status='pending'").get(record.id);
  if (pending)
    return res.status(409).json({ message: "A correction request for this absence is already pending." });
  const id = randomUUID();
  db.prepare("INSERT INTO attendance_corrections(id,record_id,requested_by,requested_status,reason,requested_at) VALUES(?,?,?,?,?,?)").run(id, record.id, req.auth.sub, requestedStatus, reason, now());
  for (const teacherId of classroomTeacherIds(record.classroom_id)) void notifyUser(teacherId, "attendance", "Attendance correction requested", reason, `/?page=reports`, true);
  audit(req, "attendance.correction_requested", "attendance_record", record.id, record.classroom_id, { requestedStatus, reason });
  res.status(201).json({ ok: true, message: "Correction request sent to the classroom teachers." });
});
app.get("/api/attendance/corrections", auth, (req, res) => {
  const detailSelect = `SELECT cr.*,a.status currentStatus,a.recorded_at recordedAt,a.method,a.distance_meters distanceMeters,a.location_accuracy_meters locationAccuracy,a.decision_reason decisionReason,a.classroom_id classroomId,c.name classroomName,c.subject,u.name studentName,u.identifier,s.room_number roomNumber,resolver.name resolvedByName FROM attendance_corrections cr JOIN attendance_records a ON a.id=cr.record_id JOIN classrooms c ON c.id=a.classroom_id JOIN users u ON u.id=a.user_id JOIN attendance_sessions s ON s.id=a.session_id LEFT JOIN users resolver ON resolver.id=cr.resolved_by`,
    rows = req.auth.role === "student"
      ? db.prepare(`${detailSelect} WHERE cr.requested_by=? ORDER BY cr.requested_at DESC`).all(req.auth.sub)
      : req.auth.role === "admin"
        ? db.prepare(`${detailSelect} ORDER BY cr.requested_at DESC`).all()
        : db.prepare(`${detailSelect} LEFT JOIN classroom_teachers ct ON ct.classroom_id=c.id WHERE (c.teacher_id=? OR ct.teacher_id=?) GROUP BY cr.id ORDER BY cr.requested_at DESC`).all(req.auth.sub, req.auth.sub);
  res.json(rows);
});
app.patch("/api/attendance/corrections/:id", auth, (req, res) => {
  const correction = db.prepare(`SELECT cr.*,a.classroom_id FROM attendance_corrections cr JOIN attendance_records a ON a.id=cr.record_id WHERE cr.id=?`).get(req.params.id);
  if (!correction || !canTeach(correction.classroom_id, req.auth.sub)) return res.status(404).json({ message: "Correction request not found." });
  if (correction.status !== "pending") return res.status(409).json({ message: "This request was already resolved." });
  const decision = req.body.decision;
  if (!["approved","rejected"].includes(decision)) return res.status(400).json({ message: "Decision must be approved or rejected." });
  transaction(() => {
    db.prepare("UPDATE attendance_corrections SET status=?,resolved_by=?,resolution_note=?,resolved_at=? WHERE id=?").run(decision, req.auth.sub, String(req.body.note || ""), now(), correction.id);
    if (decision === "approved") db.prepare("UPDATE attendance_records SET status=?,decision_reason=? WHERE id=?").run(correction.requested_status, `Corrected by teacher: ${correction.reason}`, correction.record_id);
  });
  const requester = db.prepare("SELECT requested_by FROM attendance_corrections WHERE id=?").get(correction.id);
  void notifyUser(requester.requested_by, "attendance", `Attendance correction ${decision}`, decision === "approved" ? "Your requested attendance correction was approved." : "Your requested attendance correction was rejected.", "/?page=reports", true);
  audit(req, `attendance.correction_${decision}`, "attendance_record", correction.record_id, correction.classroom_id, { note: req.body.note || "" });
  res.json({ ok: true });
});

app.get("/api/admin/dashboard", auth, adminOnly, (_req, res) => {
  const scalar = (sql) => db.prepare(sql).get().count;
  res.json({
    users: scalar("SELECT COUNT(*) count FROM users"),
    classrooms: scalar("SELECT COUNT(*) count FROM classrooms WHERE archived_at IS NULL"),
    attendanceSessions: scalar("SELECT COUNT(*) count FROM attendance_sessions"),
    pendingCorrections: scalar("SELECT COUNT(*) count FROM attendance_corrections WHERE status='pending'"),
    faceFailures24h: scalar("SELECT COUNT(*) count FROM security_events WHERE event_type LIKE 'face.%' AND severity<>'info' AND datetime(created_at)>=datetime('now','-1 day')"),
    securityEvents: db.prepare("SELECT se.*,u.name userName,u.email FROM security_events se LEFT JOIN users u ON u.id=se.user_id ORDER BY se.created_at DESC LIMIT 100").all(),
    auditLogs: db.prepare("SELECT al.*,u.name actorName FROM audit_logs al LEFT JOIN users u ON u.id=al.actor_id ORDER BY al.created_at DESC LIMIT 100").all(),
    usersList: db.prepare("SELECT id,name,email,role,department,identifier,created_at createdAt FROM users ORDER BY created_at DESC LIMIT 200").all(),
    classroomsList: db.prepare("SELECT c.id,c.name,c.subject,c.archived_at archivedAt,u.name ownerName,(SELECT COUNT(*) FROM memberships m WHERE m.classroom_id=c.id) studentCount FROM classrooms c JOIN users u ON u.id=c.teacher_id ORDER BY c.created_at DESC LIMIT 200").all(),
  });
});

app.use("/api", (_req, res) =>
  res.status(404).json({ message: "API endpoint not found." }),
);

app.use(express.static(frontendDist));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/"))
    return res.sendFile(join(frontendDist, "index.html"));
  next();
});
app.use((error, _req, res, next) => {
  void next;
  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});
const attendanceFinalizer = setInterval(finalizeExpiredAttendanceSessions, 15_000);
attendanceFinalizer.unref();
finalizeExpiredAttendanceSessions();
const notificationCleanup = setInterval(cleanupReadNotifications, 6 * 60 * 60_000);
notificationCleanup.unref();
cleanupReadNotifications();

app.listen(port, "0.0.0.0", () =>
  console.log(
    `Classmark API listening on 0.0.0.0:${port} (SQLite + JWT; attendance auto-finalization enabled)`,
  ),
);

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const databasePath = process.env.NODE_ENV === 'test' && process.env.CLASSMARK_TEST_DATABASE_PATH
  ? resolve(process.env.CLASSMARK_TEST_DATABASE_PATH)
  : join(backendRoot, 'data', 'classmark.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })

export const db = new DatabaseSync(databasePath)
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','teacher','admin')),
    department TEXT NOT NULL DEFAULT '', identifier TEXT NOT NULL DEFAULT '',
    profile_picture BLOB, profile_picture_type TEXT,
    profile_complete INTEGER NOT NULL DEFAULT 0 CHECK(profile_complete IN (0,1)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light','dark','system')),
    font TEXT NOT NULL DEFAULT 'dm-sans',
    email_notifications INTEGER NOT NULL DEFAULT 1 CHECK(email_notifications IN (0,1)),
    attendance_notifications INTEGER NOT NULL DEFAULT 1 CHECK(attendance_notifications IN (0,1)),
    invitation_notifications INTEGER NOT NULL DEFAULT 1 CHECK(invitation_notifications IN (0,1)),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS classrooms (
    id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name TEXT NOT NULL, subject TEXT NOT NULL, section TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#6c5ce7', created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL,
    UNIQUE(classroom_id,user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS classroom_teachers (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL,
    UNIQUE(classroom_id,teacher_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS attendance_sessions (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, room_number TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters INTEGER NOT NULL CHECK(radius_meters BETWEEN 10 AND 100),
    code TEXT NOT NULL UNIQUE, starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, finalized_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS attendance_records (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    method TEXT, distance_meters INTEGER, status TEXT NOT NULL CHECK(status IN ('present','absent')),
    recorded_at TEXT NOT NULL, UNIQUE(session_id,user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS face_profiles (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    image BLOB NOT NULL, image_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending-embedding',
    enrolled_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('general','attendance','invitation')),
    title TEXT NOT NULL, message TEXT NOT NULL, link TEXT,
    read_at TEXT, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS classroom_posts (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    content TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS classroom_resources (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL, url TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    shared_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_at TEXT, points INTEGER NOT NULL DEFAULT 100 CHECK(points > 0),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS assignment_submissions (
    id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
    submitted_at TEXT NOT NULL, grade REAL, feedback TEXT, graded_at TEXT,
    UNIQUE(assignment_id, student_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_attendance_classroom ON attendance_records(classroom_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON attendance_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_expiry ON password_reset_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,read_at,created_at);
  CREATE INDEX IF NOT EXISTS idx_posts_classroom ON classroom_posts(classroom_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_assignments_classroom ON assignments(classroom_id,due_at);
`)

const classroomColumns = db.prepare('PRAGMA table_info(classrooms)').all().map((column) => column.name)
if (!classroomColumns.includes('class_code')) db.exec('ALTER TABLE classrooms ADD COLUMN class_code TEXT')
if (!classroomColumns.includes('archived_at')) db.exec('ALTER TABLE classrooms ADD COLUMN archived_at TEXT')
if (!classroomColumns.includes('is_locked')) db.exec('ALTER TABLE classrooms ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0')
db.exec(`UPDATE classrooms SET class_code=upper(substr(hex(randomblob(8)),1,10)) WHERE class_code IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS idx_classrooms_code ON classrooms(class_code);`)
db.exec('DROP TABLE IF EXISTS push_subscriptions;')
db.exec('DROP TABLE IF EXISTS face_events;')

const invitationColumns = db.prepare('PRAGMA table_info(invitations)').all().map((column) => column.name)
if (!invitationColumns.includes('invitee_role')) db.exec("ALTER TABLE invitations ADD COLUMN invitee_role TEXT NOT NULL DEFAULT 'student'")

const postColumns = db.prepare('PRAGMA table_info(classroom_posts)').all().map((column) => column.name)
if (!postColumns.includes('post_type')) db.exec("ALTER TABLE classroom_posts ADD COLUMN post_type TEXT NOT NULL DEFAULT 'announcement'")
if (!postColumns.includes('reference_id')) db.exec('ALTER TABLE classroom_posts ADD COLUMN reference_id TEXT')
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_enrollment_id ON users(identifier) WHERE identifier <> ''; CREATE INDEX IF NOT EXISTS idx_resources_classroom ON classroom_resources(classroom_id,created_at);")

const faceProfileColumns = db.prepare('PRAGMA table_info(face_profiles)').all().map((column) => column.name)
for (const [name, definition] of [
  ['provider', "TEXT NOT NULL DEFAULT 'local'"],
  ['collection_id', 'TEXT'],
  ['provider_user_id', 'TEXT'],
  ['face_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ['consent_at', 'TEXT'],
  ['last_verified_at', 'TEXT'],
  ['revoked_at', 'TEXT'],
]) if (!faceProfileColumns.includes(name)) db.exec(`ALTER TABLE face_profiles ADD COLUMN ${name} ${definition}`)

const attendanceRecordColumns = db.prepare('PRAGMA table_info(attendance_records)').all().map((column) => column.name)
for (const [name, definition] of [
  ['qr_verified_at', 'TEXT'],
  ['face_verified_at', 'TEXT'],
  ['face_event_id', 'TEXT'],
  ['decision_reason', "TEXT NOT NULL DEFAULT ''"],
  ['location_accuracy_meters', 'REAL'],
]) if (!attendanceRecordColumns.includes(name)) db.exec(`ALTER TABLE attendance_records ADD COLUMN ${name} ${definition}`)

const attendanceSessionColumns = db.prepare('PRAGMA table_info(attendance_sessions)').all().map((column) => column.name)
if (!attendanceSessionColumns.includes('location_accuracy_meters')) db.exec('ALTER TABLE attendance_sessions ADD COLUMN location_accuracy_meters REAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS face_enrollment_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    aws_session_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('created','processing','succeeded','failed','expired')),
    consent_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS face_auth_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('create-attendance')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS face_verification_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    aws_session_id TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK(purpose IN ('create-attendance','attendance')),
    attendance_session_id TEXT REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('created','processing','succeeded','failed','expired')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, completed_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS admin_login_face_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    aws_session_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('created','processing','succeeded','failed','expired')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, completed_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS attendance_review_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    requested_at TEXT NOT NULL,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT, resolution_note TEXT NOT NULL DEFAULT '',
    UNIQUE(session_id,user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS class_schedules (
    id TEXT PRIMARY KEY,
    classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
    start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    room_number TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
    classroom_id TEXT REFERENCES classrooms(id) ON DELETE SET NULL,
    details TEXT NOT NULL DEFAULT '{}', ip_address TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS attendance_corrections (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
    requested_by TEXT NOT NULL REFERENCES users(id), requested_status TEXT NOT NULL CHECK(requested_status IN ('present','absent')),
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL, resolution_note TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL, resolved_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
    classroom_id TEXT REFERENCES classrooms(id) ON DELETE SET NULL,
    details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]', device_type TEXT, backed_up INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT 'Passkey', created_at TEXT NOT NULL, last_used_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    email TEXT, purpose TEXT NOT NULL CHECK(purpose IN ('register','authenticate')),
    challenge TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_face_sessions_user ON face_enrollment_sessions(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_face_auth_grants_user ON face_auth_grants(user_id,expires_at);
  CREATE INDEX IF NOT EXISTS idx_face_verification_user ON face_verification_sessions(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_admin_login_face_user ON admin_login_face_sessions(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_attendance_reviews_session ON attendance_review_requests(session_id,status);
  CREATE INDEX IF NOT EXISTS idx_schedules_classroom ON class_schedules(classroom_id,weekday,start_time);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_corrections_status ON attendance_corrections(status,requested_at);
  CREATE INDEX IF NOT EXISTS idx_security_created ON security_events(created_at,severity);
  CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
`)

export function transaction(work) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = work(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}

export const now = () => new Date().toISOString()

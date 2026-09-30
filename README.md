# Classmark Attendance System

Classmark is a full-stack classroom platform with teacher and student accounts, invitations, assignments, resources, profile settings, QR/location attendance, and AWS Rekognition face workflows.

This is the only general project guide. AWS-specific preparation is documented separately in [`REKOGNITION_SETUP.md`](REKOGNITION_SETUP.md).

## Requirements

- Node.js 22 LTS
- npm 10 or newer
- Git
- A modern browser with camera and location permission
- Nginx and systemd for the recommended EC2 deployment

## Project structure

```text
Attendance-System/
├── backend/
│   ├── src/
│   │   ├── database/
│   │   │   └── database.js       SQLite schema, migrations and connection
│   │   ├── services/
│   │   │   └── awsFaces.js       AWS Rekognition operations
│   │   └── index.js              Express application and API routes
│   ├── data/                      Runtime data; ignored by Git
│   ├── .env.example
│   ├── eslint.config.js
│   ├── package.json
│   └── package-lock.json
├── frontend/
│   ├── src/
│   │   ├── features/
│   │   │   ├── attendance/       QR camera scanning
│   │   │   ├── auth/             Login, registration and recovery
│   │   │   ├── classrooms/       Classes, people and assignments
│   │   │   ├── faces/            Face enrollment and identification
│   │   │   ├── admin/            System oversight and audit dashboard
│   │   │   ├── notifications/    In-app notification center
│   │   │   ├── people/           Cross-class teacher roster
│   │   │   ├── reports/          Reports and correction workflow
│   │   │   ├── schedule/         Recurring classroom timetable
│   │   │   └── settings/         Profile, theme, font and security
│   │   ├── lib/                  Shared browser utilities
│   │   ├── styles/               Global and feature styles
│   │   ├── App.jsx               Application shell
│   │   └── main.jsx              React entry point
│   ├── .env.example
│   ├── eslint.config.js
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   └── vite.config.js
├── .gitignore
├── README.md                      This guide
└── REKOGNITION_SETUP.md          AWS Rekognition guide
```

The frontend and backend are independent Node projects. There is intentionally no root `package.json` or npm workspace.

## Environment files

Create local environment files from the tracked examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Important backend values:

```dotenv
PORT=4000
JWT_SECRET=replace-with-a-long-random-value
APP_URL=http://localhost:5173

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=Classmark <no-reply@classmark.local>

AWS_REGION=ap-south-1
REKOGNITION_COLLECTION_ID=classmark-faces
COGNITO_IDENTITY_POOL_ID=
FACE_LIVENESS_THRESHOLD=60
FACE_LIVENESS_CHALLENGE=movement
FACE_MATCH_THRESHOLD=92
FACE_AMBIGUITY_MARGIN=3
```

Generate a production JWT secret with `openssl rand -hex 64`. On EC2, attach an IAM role instead of storing permanent AWS access keys.

For the frontend, keep this empty when Vite or Nginx proxies `/api`:

```dotenv
VITE_API_URL=
```

Never put secrets in a `VITE_*` variable because Vite publishes those values to the browser.

## Local development

Use two terminals.

Backend:

```bash
cd backend
npm install
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:4000`
- LAN frontend: `http://YOUR_COMPUTER_LAN_IP:5173`

The backend listens on `0.0.0.0`. Vite also listens on all interfaces and proxies `/api` to the backend.

## Commands

Backend commands, run from `backend/`:

```bash
npm run dev       # development server with automatic restart
npm start         # production server
npm run lint      # backend checks
npm test          # policy and fresh-schema integrity tests
```

Frontend commands, run from `frontend/`:

```bash
npm run dev       # Vite development server
npm run build     # production build in frontend/dist
npm run preview   # preview the production build
npm run lint      # frontend checks
```

## Data and security

- SQLite is always stored at `backend/data/classmark.sqlite`. Its EC2 path is
  `/opt/classmark/backend/data/classmark.sqlite` when the repository is deployed
  at `/opt/classmark`.
- SQLite, WAL files, `.env`, build output and dependencies are ignored by Git.
- Back up SQLite while the backend is stopped to ensure a consistent copy.
- Do not commit JWT secrets, SMTP passwords, AWS credentials or biometric data.
- The backend can serve the sibling `frontend/dist`, but Nginx static delivery is recommended in production.

The production database path is intentionally not configurable, so starting
Node from a different working directory cannot create a second database.
`backend/src/data/` is obsolete and unsupported. SQLite WAL mode, foreign-key
enforcement, strict tables, uniqueness constraints, and a five-second busy
timeout are enabled at startup.

## Roles and implemented behavior

### Student

- Registers with a unique enrollment/roll number, completes missing department
  details, and must enroll a live face before portal APIs are unlocked.
- Joins an unlocked classroom with its 10-character code or accepts an
  email-bound student invitation.
- Reads the stream, assignments, resources, roster, marks, timetable, and only
  their own attendance history.
- Submits assignments only before the deadline. A missing submission receives
  zero when the deadline passes.
- Completes attendance in the order QR → GPS proximity → AWS Face Liveness →
  Rekognition identity match.
- Can request immediate manual face review after QR/GPS succeeds, or later
  dispute only an absent finalized record. Students cannot access teacher
  reports or exports.

### Teacher and co-teacher

- Must complete profile details and live-face enrollment before classroom APIs
  are unlocked.
- Creates classrooms, announcements, assignments, resources, schedules,
  invitations, and attendance sessions.
- A co-teacher has teaching authority for content, grading, attendance, people,
  and schedules. Only the owner can edit, lock, archive, restore, or permanently
  delete the classroom.
- Must pass a new AWS live-face authentication immediately before each QR
  attendance session. Only one unexpired session may exist per classroom.
- Reviews student submissions, manual attendance requests, finalized absence
  corrections, and exports attendance reports as CSV or PDF.

### Administrator

- Is assigned through `ADMIN_EMAILS`; there is no default administrator
  password. The account uses its normal password or passkey.
- Must enroll a face and complete a fresh AWS live-face check after every new
  login before privileged APIs are unlocked.
- Sees system-wide users, classrooms, attendance reports, correction status,
  security events, and audit history. Correction decisions remain with the
  relevant classroom teachers.
- Does not receive teacher/student classroom notifications.

### Shared interface behavior

- Global search finds only authorized classrooms, people, assignments, and
  resources. `Ctrl/Command + K` focuses it; mobile has a dedicated search
  control.
- Buttons, links, form controls, and symbol-only controls receive accessible
  labels and explanatory browser tooltips.
- Theme and font settings are stored per account. Dates are rendered in the
  browser/device timezone; the browser sends its validated IANA timezone for
  overview calculations.
- In-app notifications persist while unread. Read notifications are pruned by
  age and per-user retention limits. Deleted or archived classroom links are
  disabled instead of pointing to missing content.
- Archive, permanent deletion, leaving a classroom, face deletion, assignment
  deletion, and other destructive actions require confirmation in the UI.

## Relational database schema

Classmark uses one SQLite database. UUID text values are primary keys unless a
table is explicitly keyed by its parent. ISO-8601 UTC strings are stored for
timestamps and converted for display by the client.

| Table | Purpose and important relationships |
|---|---|
| `users` | Accounts, BCrypt password hash, role, department, unique faculty/enrollment identifier, optional profile-picture BLOB, and profile state. |
| `user_settings` | One-to-one with `users`; theme, font, and notification preferences. Deleted with the user. |
| `classrooms` | Classroom name, subject, section, owner (`teacher_id`), unique 10-character code, color, lock state, archive time, and creation time. |
| `memberships` | Student-to-classroom junction table with a unique `(classroom_id, user_id)` pair. |
| `classroom_teachers` | Co-teacher-to-classroom junction table with a unique `(classroom_id, teacher_id)` pair. |
| `invitations` | Email-bound, role-bound classroom invitation token, expiration, and acceptance time. |
| `classroom_posts` | Stream entries linked to a classroom and author; `post_type` distinguishes announcements, assignments, and resources, while `reference_id` links generated stream activity. |
| `classroom_resources` | Teacher-shared HTTP(S) resource metadata linked to a classroom and sharing user. |
| `assignments` | Classroom assignment content, deadline, allocated points, creator, and creation time. |
| `assignment_submissions` | One row per assignment/student, containing submission content, grade, feedback, and grading time. Missing expired work is represented relationally as a zero-grade row. |
| `class_schedules` | Recurring classroom weekday, local start/end times, room, creator, and creation time. Overlapping entries for the same classroom are rejected by the API. |
| `attendance_sessions` | Five-minute QR session, classroom, hosting teacher, room, teacher coordinates/accuracy, allowed radius, secret code, start/expiry, and finalization time. |
| `attendance_records` | Unique session/student result with QR time, face time, method, GPS distance/accuracy, status, decision reason, and optional face-event reference. |
| `attendance_review_requests` | Immediate manual-review workflow for a QR/GPS-approved student whose live face could not be completed; unique per session/student. |
| `attendance_corrections` | Post-finalization absence dispute, requested status/reason, decision, resolving teacher, note, and timestamps. |
| `notifications` | Per-user in-app notification type, title, message, optional navigation link, read time, and creation time. |
| `face_profiles` | One verified biometric mapping per user: AWS provider, collection, provider user ID, JSON face-ID list, consent/enrollment/verification/revocation metadata. The image column remains an empty compatibility BLOB for AWS-vector profiles. |
| `face_enrollment_sessions` | Short-lived AWS Face Liveness enrollment session and lifecycle status. |
| `face_verification_sessions` | Short-lived teacher/student attendance liveness and identity-verification session. |
| `face_auth_grants` | Single-use, expiring teacher authorization produced by face verification before QR generation. |
| `admin_login_face_sessions` | Short-lived mandatory administrator login liveness/identity check. |
| `password_reset_tokens` | SHA-256 token hash, owner, expiration, use time, and creation time. Plain reset tokens are never stored. |
| `passkeys` | WebAuthn credential ID, public key, signature counter, transports, device metadata, and use timestamps. |
| `webauthn_challenges` | Expiring registration/authentication challenges tied to a user and optional email. |
| `audit_logs` | Actor, action, entity, optional classroom, JSON detail payload, IP address, and timestamp for accountable mutations. |
| `security_events` | User/classroom security signals such as face failures and GPS anomalies with severity and JSON details. |

Foreign keys use `CASCADE`, `SET NULL`, or `RESTRICT` according to ownership and
audit requirements. Partial and composite unique indexes protect classroom
codes, account identifiers, invitation tokens, memberships, submissions, and
face mappings. Supporting indexes cover expiry, classroom lookups,
notifications, schedules, audits, corrections, passkeys, and security events.

Legacy `face_events` and obsolete `push_subscriptions` tables are removed
automatically during startup. Neither table is part of the supported schema.

## Storage boundaries: RDBMS and external state

All authoritative Classmark application records listed above are stored in the
SQLite relational database. No MongoDB, DynamoDB, Redis, Firebase, browser
database, JSON-file database, or other application datastore is used.

The following are deliberately outside SQLite and are not alternative
application databases:

- AWS Rekognition stores biometric face vectors in the configured collection
  and processes Face Liveness sessions. SQLite stores the relational mapping,
  consent, status, confidence-related audit data, and AWS identifiers—not a
  reusable face photograph for an AWS profile.
- The browser stores the signed JWT and temporary interface preferences in Web
  Storage. This is session/client state, not authoritative institutional data.
- Cognito Identity Pools issue temporary browser credentials for Face
  Liveness; they are not a Classmark datastore.
- SMTP transports invitations, reset links, and summaries. Email providers
  naturally retain delivered mail outside Classmark.
- Nginx serves compiled static assets, while systemd/journald retains process
  logs. Neither is used as an application database.
- The described S3 backup is optional disaster-recovery object storage for an
  encrypted SQLite snapshot, not a live source of application records.

## Identity and attendance workflow

1. Every new teacher and student signs in and completes AWS live-face enrollment before the rest of the portal is activated.
2. An enrolled teacher must authenticate against their saved face immediately before generating each attendance QR code. The authorization is valid for five minutes and can create only one session.
3. A student scans the live QR code and passes classroom proximity verification.
4. The student completes an AWS Face Liveness movement challenge. The returned live reference image must match their own enrolled Rekognition identity at the configured threshold.
5. Attendance is complete only after QR, location, liveness, and face identity verification all pass. QR/location without live-face verification is retained as a partial absent record, not present attendance.
6. If face authentication cannot be completed, the student can request manual verification. Classroom teachers receive an in-app notification and can approve or reject the request in the attendance page.
7. In-app notifications have no unread-count limit. Unread items remain until viewed; read items are retained for 90 days with at most 200 recent read notifications per user by default. Both limits are configurable in `backend/.env`.

## Fresh EC2 installation

The commands below assume Ubuntu, `/opt/classmark`, a root-owned Git checkout, Nginx, and systemd. Replace the repository URL and domain.

### 1. Install software

```bash
apt-get update
apt-get install -y git nginx curl ca-certificates build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
npm --version
```

### 2. Configure Git

```bash
git config --global user.name "Sujit Halder"
git config --global user.email "YOUR_GITHUB_EMAIL"
```

The repository uses HTTPS. Public pulls require no GitHub authentication. To push from EC2, use your GitHub username and a fine-grained personal access token when Git requests a password. Do not put the token in the repository or an environment file.

### 3. Clone

```bash
cd /opt
git clone https://github.com/Sujit-Halder/Facial-QR-code-based-classroom.git classmark
cd /opt/classmark
git status
git remote -v
```

### 4. Configure and install the backend

```bash
cd /opt/classmark/backend
cp .env.example .env
nano .env
npm ci --omit=dev
mkdir -p data
```

For production, set `APP_URL=https://YOUR_DOMAIN.com`. Restore a previous `classmark.sqlite` into `backend/data/` before starting the service if required.

Create a restricted runtime account while keeping the Git checkout owned by root:

```bash
id classmark >/dev/null 2>&1 || useradd --system --home /opt/classmark/backend --shell /usr/sbin/nologin classmark
chown -R classmark:classmark /opt/classmark/backend/data
chown root:classmark /opt/classmark/backend/.env
chmod 640 /opt/classmark/backend/.env
```

### 5. Build the frontend

```bash
cd /opt/classmark/frontend
cp .env.example .env
npm ci --include=dev
npm run build
```

Keep `VITE_API_URL=` empty when the site and API use the same domain.

### 6. Create the systemd service

Create `/etc/systemd/system/classmark.service`:

```ini
[Unit]
Description=Classmark Backend API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=classmark
Group=classmark
WorkingDirectory=/opt/classmark/backend
ExecStart=/usr/bin/node /opt/classmark/backend/src/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Activate it:

```bash
systemctl daemon-reload
systemctl enable classmark
systemctl restart classmark
systemctl status classmark --no-pager
curl http://127.0.0.1:4000/api/health
```

View logs with:

```bash
journalctl -u classmark -n 100 --no-pager
```

### 7. Configure Nginx

Create `/etc/nginx/sites-available/classmark`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name YOUR_DOMAIN.com www.YOUR_DOMAIN.com;

    root /opt/classmark/frontend/dist;
    index index.html;
    client_max_body_size 6M;

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }

    location /assets/ {
        try_files $uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

Enable and validate:

```bash
ln -sfn /etc/nginx/sites-available/classmark /etc/nginx/sites-enabled/classmark
unlink /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t
systemctl reload nginx
```

### 8. Enable HTTPS

Point the domain to the EC2 public IP, then run:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d YOUR_DOMAIN.com -d www.YOUR_DOMAIN.com
certbot renew --dry-run
```

Allow ports 22, 80 and 443 in the EC2 security group. Restrict port 22 to your own IP and do not expose port 4000.

## Production updates

Because root owns the checkout, Git commands work directly without `sudo -u`:

```bash
cd /opt/classmark
git status
git pull --ff-only

cd /opt/classmark/backend
npm ci --omit=dev

cd /opt/classmark/frontend
npm ci --include=dev
npm run build

chown -R classmark:classmark /opt/classmark/backend/data
chown root:classmark /opt/classmark/backend/.env
chmod 640 /opt/classmark/backend/.env

systemctl restart classmark
nginx -t
systemctl reload nginx
```

For server-side source changes:

```bash
cd /opt/classmark
git add .
git commit -m "Describe the change"
git push origin main
```

Prefer editing locally and deploying with `git pull --ff-only`.

## Git troubleshooting on EC2

Inspect first:

```bash
cd /opt/classmark
git status
git remote -v
git branch -vv
```

- **Not a Git repository:** clone instead of copying files; `.git` is missing.
- **Authentication failed while pushing:** GitHub account passwords are not accepted for Git operations. Use your GitHub username and a fine-grained personal access token with repository write permission.
- **Local changes block pull:** commit legitimate changes or use `git stash`. Never discard production data blindly.
- **No upstream branch:** run `git branch --set-upstream-to=origin/main main`.
- **Incorrect remote:** restore the HTTPS remote with `git remote set-url origin https://github.com/Sujit-Halder/Facial-QR-code-based-classroom.git`.
- **Dubious ownership:** ensure root owns this intended checkout, then use `git config --global --add safe.directory /opt/classmark` only after verifying the path.

Never commit or delete `backend/.env` or `backend/data/classmark.sqlite`. Avoid `git reset --hard` on a production server without verified backups.

## Verification

Before deployment:

```bash
cd frontend
npm run lint
npm run build

cd ../backend
npm run lint
npm test
```

After deployment:

```bash
curl -I https://YOUR_DOMAIN.com
curl https://YOUR_DOMAIN.com/api/health
systemctl status classmark --no-pager
systemctl status nginx --no-pager
```

## Planned encrypted SQLite backups to S3

This repository intentionally does not upload or schedule backups automatically. Production backup implementation should use this design:

1. Attach an EC2 IAM role that can write only to a dedicated backup prefix such as `s3://YOUR_BUCKET/classmark/` and can use the selected KMS key. Do not place AWS access keys in `.env`.
2. Create a consistent SQLite snapshot with the SQLite backup command, rather than copying the live WAL database file directly:

   ```bash
   sqlite3 /opt/classmark/backend/data/classmark.sqlite ".backup '/var/backups/classmark/classmark.sqlite'"
   ```

3. Compress the completed snapshot and upload it with server-side KMS encryption:

   ```bash
   gzip -f /var/backups/classmark/classmark.sqlite
   aws s3 cp /var/backups/classmark/classmark.sqlite.gz s3://YOUR_BUCKET/classmark/classmark-$(date -u +%Y%m%dT%H%M%SZ).sqlite.gz --sse aws:kms --sse-kms-key-id YOUR_KMS_KEY_ARN
   ```

4. Run the reviewed script from a systemd timer under the `classmark` service account. Store temporary snapshots outside the Git checkout and restrict the directory to that account.
5. Configure S3 Versioning, Block Public Access, and a lifecycle rule—for example, daily backups for 30 days and monthly backups for 12 months.
6. Send failed timer executions to CloudWatch or SNS. Never treat an upload exit code alone as proof of recoverability.
7. Perform a monthly restore drill on a separate EC2 instance: download one encrypted object, decompress it, run `PRAGMA integrity_check`, start Classmark against the restored database, and verify users, classrooms, attendance, and audit records.

For production passkeys, set the exact HTTPS domain (no path):

```env
WEBAUTHN_RP_ID=classroom.sujithalder.in
WEBAUTHN_ORIGIN=https://classroom.sujithalder.in
WEBAUTHN_RP_NAME=Classmark
ADMIN_EMAILS=admin@example.com
```

Classmark detects each signed-in device's IANA timezone in the browser. The
overview and timetable therefore use that device's local day; no fixed
`APP_TIMEZONE` setting is required. Reload the page after changing the device
timezone.

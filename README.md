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
│   ├── .gitignore
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
│   │   │   └── settings/         Profile, theme, font and security
│   │   ├── lib/                  Shared browser utilities
│   │   ├── styles/               Global and feature styles
│   │   ├── App.jsx               Application shell
│   │   └── main.jsx              React entry point
│   ├── .env.example
│   ├── .gitignore
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
DATABASE_PATH=./data/classmark.sqlite

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
```

Frontend commands, run from `frontend/`:

```bash
npm run dev       # Vite development server
npm run build     # production build in frontend/dist
npm run preview   # preview the production build
npm run lint      # frontend checks
```

## Data and security

- SQLite is stored at `backend/data/classmark.sqlite` by default.
- SQLite, WAL files, `.env`, build output and dependencies are ignored by Git.
- Back up SQLite while the backend is stopped to ensure a consistent copy.
- Do not commit JWT secrets, SMTP passwords, AWS credentials or biometric data.
- The backend can serve the sibling `frontend/dist`, but Nginx static delivery is recommended in production.

## Identity and attendance workflow

1. Every new teacher and student signs in and completes AWS live-face enrollment before the rest of the portal is activated.
2. An enrolled teacher must authenticate against their saved face immediately before generating each attendance QR code. The authorization is valid for five minutes and can create only one session.
3. A student scans the live QR code and passes classroom proximity verification.
4. The student then captures a front-camera image that must match their own enrolled Rekognition identity.
5. Attendance is complete only after QR, location, and face verification all pass. QR/location without face is retained as a partial record, not present attendance.
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
```

After deployment:

```bash
curl -I https://YOUR_DOMAIN.com
curl https://YOUR_DOMAIN.com/api/health
systemctl status classmark --no-pager
systemctl status nginx --no-pager
```

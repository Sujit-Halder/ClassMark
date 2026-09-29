# Classmark Attendance System

Classmark provides teacher/student access, classrooms, invitations, assignments, resources, QR and location-verified attendance, profile settings, and AWS Rekognition face workflows.

The repository contains two independent Node.js applications. Each owns its dependencies, commands and lockfile.

## Repository structure

```text
Attendance-System/
├── backend/
│   ├── src/
│   │   ├── database/
│   │   ├── services/
│   │   └── index.js
│   ├── data/                 runtime SQLite database (ignored)
│   ├── .env.example
│   ├── .gitignore
│   ├── README.md
│   ├── package.json
│   └── package-lock.json
├── frontend/
│   ├── src/
│   │   ├── features/
│   │   ├── lib/
│   │   ├── styles/
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── .env.example
│   ├── .gitignore
│   ├── README.md
│   ├── package.json
│   ├── package-lock.json
│   └── vite.config.js
├── .gitignore
├── README.md
└── REKOGNITION_SETUP.md
```

## Local development

Use two terminals. There is intentionally no root npm workspace.

Terminal 1:

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Terminal 2:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- LAN: `http://YOUR_COMPUTER_LAN_IP:5173`

See [frontend/README.md](frontend/README.md) and [backend/README.md](backend/README.md) for details.

## EC2 update for this structure

After pulling the new version:

```bash
cd /opt/classmark/backend
npm ci --omit=dev

cd /opt/classmark/frontend
npm ci --include=dev
npm run build
```

The backend does not need frontend build tools. Restart it after installation and build:

```bash
pm2 restart classmark
pm2 save
```

If PM2 previously used the removed root workspace command, replace it once:

```bash
pm2 delete classmark
cd /opt/classmark/backend
pm2 start src/index.js --name classmark
pm2 save
```

For systemd, use `WorkingDirectory=/opt/classmark/backend` and `ExecStart=/usr/bin/node /opt/classmark/backend/src/index.js`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart classmark
```

Keep Nginx serving `/opt/classmark/frontend/dist` and proxying `/api/` to `http://127.0.0.1:4000`.

## Why `git pull` may fail on EC2

First inspect the actual error:

```bash
cd /opt/classmark
git status
git remote -v
git branch --show-current
```

Common causes and fixes:

1. **`not a git repository`** — the directory was uploaded rather than cloned, or `.git` is missing. Preserve `.env` and the database, then clone the repository properly.
2. **Permission denied** — files are owned by another account. Make the real deployment user the owner, for example `sudo chown -R ubuntu:ubuntu /opt/classmark`.
3. **GitHub authentication failed** — account passwords cannot authenticate Git operations. Configure an SSH deploy key or fine-grained token and correct `origin`.
4. **Local changes would be overwritten** — run `git status`. Commit legitimate source changes or use `git stash`. Keep `.env` and SQLite ignored; never blindly reset production data.
5. **Dubious ownership** — only after verifying the directory is trusted, run `git config --global --add safe.directory /opt/classmark` as the deployment user.
6. **No upstream branch** — run `git branch --set-upstream-to=origin/main main` once, adjusting the branch name if needed.

A normal safe update is:

```bash
cd /opt/classmark
git status
git pull --ff-only
```

Do not use `git reset --hard` on EC2 unless `.env`, `backend/data/classmark.sqlite`, and intentional server changes have been backed up.

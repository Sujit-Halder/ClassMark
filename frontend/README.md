# Classmark Frontend

React, Vite and Tailwind CSS client for Classmark.

## Requirements

- Node.js 22 LTS
- npm 10 or newer
- Backend API running on port `4000` during development

## Install and run

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite listens on LAN interfaces and proxies `/api` to `http://127.0.0.1:4000`.

## Commands

```bash
npm run dev       # development server
npm run build     # production files in frontend/dist
npm run preview   # preview the production build
npm run lint      # code checks
```

## Environment

Copy `.env.example` to `.env`. Leave `VITE_API_URL` empty when Nginx serves the site and proxies `/api` on the same domain. Never place secrets in a `VITE_*` value because it becomes public browser code.

## Source layout

```text
src/
├── features/
│   ├── attendance/   QR scanning UI
│   ├── auth/         Authentication and password recovery
│   ├── classrooms/   Classroom, roster and assignment UI
│   ├── faces/        AWS Rekognition UI
│   └── settings/     Profile, appearance and security settings
├── lib/              Shared browser utilities
├── styles/           Global and feature styles
├── App.jsx           Application shell
└── main.jsx          React entry point
```

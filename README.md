# Facial and QR Code Attendance System

An attendance-management project for teachers and students, using facial recognition or QR codes. The frontend runs on React, Vite, and Tailwind CSS.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

## Development

```bash
npm install
npm run dev
```

This starts both applications concurrently:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:4000`

To run them separately:

```bash
npm run dev:frontend
npm run dev:backend
```

## Environment

```bash
copy frontend\.env.example frontend\.env
copy backend\.env.example backend\.env
```

Configure SMTP values in `backend/.env` to send real invitation emails. Without SMTP, invite links are printed in the backend terminal.

## Project structure

```text
attendance-system/
├── frontend/
│   ├── src/                 React UI and styles
│   ├── .env.example         Browser API configuration
│   ├── eslint.config.js
│   ├── package.json
│   └── vite.config.js
├── backend/
│   ├── src/index.js         Express API
│   ├── data/db.json         Development data store
│   ├── .env.example         Server and SMTP configuration
│   ├── eslint.config.js
│   └── package.json
├── package.json             npm workspace commands
└── package-lock.json        Shared dependency lock
```

Install once from the repository root. npm workspaces manage both applications.

## Implemented MVP

- Teacher/student registration and password authentication
- Required profile fields, profile pictures, preferences, and role-based permissions
- Teacher-owned classrooms and email-bound invitations
- Five-minute QR sessions with teacher/student GPS distance validation
- Automatic absent records and teacher attendance at finalization
- Browser camera capture and biometric enrollment pipeline
- Normalized SQLite storage with strict tables, foreign keys, indexes, WAL, and transactions

Production facial matching requires a recognition provider or self-hosted model, encrypted face embeddings, liveness detection, consent/retention policies, and the selected classroom camera hardware.

## Checks

```bash
npm run lint
npm run build
```

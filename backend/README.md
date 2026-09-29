# Classmark Backend

Express API with JWT authentication, SQLite storage, email delivery, QR attendance and AWS Rekognition integration.

## Requirements

- Node.js 22 LTS (includes `node:sqlite`)
- npm 10 or newer

## Install and run

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

The API listens on `0.0.0.0:4000`, allowing authenticated LAN devices to connect.

## Commands

```bash
npm run dev       # restart when server files change
npm start         # production server
npm run lint      # code checks
```

## Source layout

```text
src/
├── database/
│   └── database.js   Schema, migrations and SQLite connection
├── services/
│   └── awsFaces.js   AWS Rekognition operations
└── index.js          Express app and API routes
data/
└── classmark.sqlite  Runtime database; created automatically and ignored
```

The server can serve the production frontend from the sibling `frontend/dist` directory. On EC2, Nginx serving that directory and proxying `/api` is recommended.

Back up the SQLite database before server migrations. Never commit `.env`, databases, AWS keys or SMTP passwords.

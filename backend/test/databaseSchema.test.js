import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

test("fresh SQLite schema is relationally valid", async () => {
  const directory = mkdtempSync(join(tmpdir(), "classmark-schema-"));
  const previousEnvironment = process.env.NODE_ENV;
  const previousPath = process.env.CLASSMARK_TEST_DATABASE_PATH;
  process.env.NODE_ENV = "test";
  process.env.CLASSMARK_TEST_DATABASE_PATH = join(directory, "classmark.sqlite");
  try {
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "database", "database.js"),
    );
    moduleUrl.searchParams.set("audit", String(Date.now()));
    const { db } = await import(moduleUrl.href);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const required of [
      "users",
      "classrooms",
      "memberships",
      "assignments",
      "attendance_sessions",
      "attendance_records",
      "face_profiles",
      "notifications",
      "audit_logs",
      "security_events",
      "passkeys",
    ])
      assert.ok(tables.includes(required), `${required} table is missing`);
    db.close();
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousPath === undefined) delete process.env.CLASSMARK_TEST_DATABASE_PATH;
    else process.env.CLASSMARK_TEST_DATABASE_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

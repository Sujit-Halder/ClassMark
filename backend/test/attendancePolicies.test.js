import test from "node:test";
import assert from "node:assert/strict";
import {
  classroomRoleCanTeach,
  faceDecisionAllowed,
  gpsReadingAllowed,
  invitationCanBeAccepted,
  sessionIsActive,
  withinAttendanceRadius,
} from "../src/lib/attendancePolicies.js";

test("QR sessions reject expiry and finalization", () => {
  const now = new Date("2026-01-01T10:00:00Z");
  assert.equal(sessionIsActive({ expires_at: "2026-01-01T10:05:00Z", finalized_at: null }, now), true);
  assert.equal(sessionIsActive({ expires_at: "2026-01-01T09:59:59Z", finalized_at: null }, now), false);
  assert.equal(sessionIsActive({ expires_at: "2026-01-01T10:05:00Z", finalized_at: now.toISOString() }, now), false);
});

test("GPS accuracy and radius boundaries are strict", () => {
  assert.equal(gpsReadingAllowed(120), true);
  assert.equal(gpsReadingAllowed(120.1), false);
  assert.equal(withinAttendanceRadius(75, 75), true);
  assert.equal(withinAttendanceRadius(75.01, 75), false);
});

test("face verification requires liveness and identity thresholds", () => {
  const valid = { status: "SUCCEEDED", livenessConfidence: 80, livenessThreshold: 80, similarity: 88, matchThreshold: 88 };
  assert.equal(faceDecisionAllowed(valid), true);
  assert.equal(faceDecisionAllowed({ ...valid, status: "FAILED" }), false);
  assert.equal(faceDecisionAllowed({ ...valid, livenessConfidence: 79.9 }), false);
  assert.equal(faceDecisionAllowed({ ...valid, similarity: 87.9 }), false);
});

test("invitations require matching email and unexpired unused token", () => {
  const invitation = { email: "student@example.com", expires_at: "2026-01-02T00:00:00Z", accepted_at: null };
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(invitationCanBeAccepted(invitation, "STUDENT@example.com", now), true);
  assert.equal(invitationCanBeAccepted(invitation, "other@example.com", now), false);
  assert.equal(invitationCanBeAccepted({ ...invitation, accepted_at: now.toISOString() }, invitation.email, now), false);
});

test("only classroom owners and co-teachers have teaching authority", () => {
  assert.equal(classroomRoleCanTeach("owner"), true);
  assert.equal(classroomRoleCanTeach("teacher"), true);
  assert.equal(classroomRoleCanTeach("student"), false);
});

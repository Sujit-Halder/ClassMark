export const sessionIsActive = (session, at = new Date()) =>
  Boolean(session && !session.finalized_at && new Date(session.expires_at) > at);

export const gpsReadingAllowed = (accuracy, maximum = 120) =>
  Number.isFinite(Number(accuracy)) && Number(accuracy) <= maximum;

export const withinAttendanceRadius = (distanceMeters, radiusMeters) =>
  Number.isFinite(Number(distanceMeters)) &&
  Number(distanceMeters) >= 0 &&
  Number(distanceMeters) <= Number(radiusMeters);

export const faceDecisionAllowed = ({
  status,
  livenessConfidence,
  livenessThreshold,
  similarity,
  matchThreshold,
}) =>
  status === "SUCCEEDED" &&
  Number(livenessConfidence) >= Number(livenessThreshold) &&
  Number(similarity) >= Number(matchThreshold);

export const invitationCanBeAccepted = (invitation, email, at = new Date()) =>
  Boolean(
    invitation &&
      !invitation.accepted_at &&
      new Date(invitation.expires_at) > at &&
      invitation.email.toLowerCase() === String(email).toLowerCase(),
  );

export const classroomRoleCanTeach = (role) =>
  role === "owner" || role === "teacher";

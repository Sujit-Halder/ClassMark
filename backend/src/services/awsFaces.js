import {
  AssociateFacesCommand,
  CreateFaceLivenessSessionCommand,
  CreateUserCommand,
  DeleteFacesCommand,
  DeleteUserCommand,
  GetFaceLivenessSessionResultsCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchUsersByImageCommand,
} from '@aws-sdk/client-rekognition'

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1'
const collectionId = process.env.REKOGNITION_COLLECTION_ID || ''
const identityPoolId = process.env.COGNITO_IDENTITY_POOL_ID || ''
const livenessThreshold = Math.min(99, Math.max(80, Number(process.env.FACE_LIVENESS_THRESHOLD || 80)))
const livenessChallenge = process.env.FACE_LIVENESS_CHALLENGE === 'movement-and-light' ? 'FaceMovementAndLightChallenge' : 'FaceMovementChallenge'
const matchThreshold = Math.min(90, Math.max(80, Number(process.env.FACE_MATCH_THRESHOLD || 88)))
const ambiguityMargin = Math.min(20, Math.max(0, Number(process.env.FACE_AMBIGUITY_MARGIN || 3)))
const client = new RekognitionClient({ region })

export const faceConfig = {
  region,
  collectionId,
  identityPoolId,
  livenessThreshold,
  livenessChallenge,
  matchThreshold,
  ambiguityMargin,
  backendConfigured: Boolean(collectionId),
  browserConfigured: Boolean(identityPoolId),
}

function requireConfiguration() {
  if (!collectionId) throw new Error('REKOGNITION_COLLECTION_ID is not configured on the server.')
}

export const providerUserId = (userId) => `usr_${String(userId).replace(/[^A-Za-z0-9_.:-]/g, '_')}`

export async function createLivenessSession(clientRequestToken) {
  requireConfiguration()
  return client.send(new CreateFaceLivenessSessionCommand({
    ClientRequestToken: clientRequestToken,
    Settings: { AuditImagesLimit: 0, ChallengePreferences: [{ Type: livenessChallenge }] },
  }))
}

export async function getLivenessResult(sessionId) {
  requireConfiguration()
  return client.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }))
}

export async function enrollReferenceImage(userId, bytes) {
  requireConfiguration()
  if (!bytes?.length) throw new Error('AWS did not return a liveness reference image.')
  const awsUserId = providerUserId(userId)
  try { await client.send(new CreateUserCommand({ CollectionId: collectionId, UserId: awsUserId })) }
  catch (error) { if (!['ConflictException', 'ResourceAlreadyExistsException'].includes(error.name)) throw error }
  const indexed = await client.send(new IndexFacesCommand({
    CollectionId: collectionId,
    Image: { Bytes: bytes },
    ExternalImageId: awsUserId,
    MaxFaces: 1,
    QualityFilter: 'AUTO',
    DetectionAttributes: [],
  }))
  const faceIds = (indexed.FaceRecords || []).map((record) => record.Face?.FaceId).filter(Boolean)
  if (!faceIds.length) throw new Error('No enrollment-quality face was found. Use even lighting and face the camera directly.')
  await client.send(new AssociateFacesCommand({ CollectionId: collectionId, UserId: awsUserId, FaceIds: faceIds }))
  return { awsUserId, faceIds, unindexedFaces: indexed.UnindexedFaces || [] }
}

export async function identifyFace(bytes) {
  requireConfiguration()
  const result = await client.send(new SearchUsersByImageCommand({
    CollectionId: collectionId,
    Image: { Bytes: bytes },
    UserMatchThreshold: matchThreshold,
    MaxUsers: 3,
  }))
  return result.UserMatches || []
}

export async function deleteEnrollment(awsUserId, faceIds = []) {
  requireConfiguration()
  if (faceIds.length) {
    try { await client.send(new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: faceIds })) }
    catch (error) { if (error.name !== 'ResourceNotFoundException') throw error }
  }
  if (awsUserId) {
    try { await client.send(new DeleteUserCommand({ CollectionId: collectionId, UserId: awsUserId })) }
    catch (error) { if (error.name !== 'ResourceNotFoundException') throw error }
  }
}

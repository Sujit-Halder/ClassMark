# AWS Rekognition production setup

The application now supports AWS Face Liveness enrollment, Rekognition user vectors, classroom-scoped mobile-camera identification, biometric deletion, and combined QR/face attendance evidence.

## Required AWS resources

All resources must use the same region, normally `ap-south-1` (Mumbai).

1. Rekognition collection: `classmark-faces`.
2. EC2 instance role with the backend Rekognition policy.
3. Cognito Identity Pool whose guest/auth role may call only `rekognition:StartFaceLivenessSession`.
4. HTTPS domain for mobile camera access.

The EC2 application must use its instance role. Never place `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` in the environment file.

## Create the collection

```bash
aws rekognition create-collection --collection-id classmark-faces --region ap-south-1
aws rekognition describe-collection --collection-id classmark-faces --region ap-south-1
```

## EC2 role policy

Attach this policy to the IAM role associated with the EC2 instance:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "rekognition:CreateFaceLivenessSession",
      "rekognition:GetFaceLivenessSessionResults",
      "rekognition:DetectFaces",
      "rekognition:IndexFaces",
      "rekognition:CreateUser",
      "rekognition:AssociateFaces",
      "rekognition:DisassociateFaces",
      "rekognition:SearchUsersByImage",
      "rekognition:SearchFacesByImage",
      "rekognition:ListFaces",
      "rekognition:ListUsers",
      "rekognition:DescribeCollection",
      "rekognition:DeleteFaces",
      "rekognition:DeleteUser"
    ],
    "Resource": "*"
  }]
}
```

Verify from EC2:

```bash
aws sts get-caller-identity
aws rekognition describe-collection --collection-id classmark-faces --region ap-south-1
```

## Cognito Identity Pool

Create an Identity Pool in `ap-south-1`. Its browser role must have only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "rekognition:StartFaceLivenessSession",
    "Resource": "*"
  }]
}
```

The Identity Pool is used only to sign the liveness video stream. Classmark continues to authenticate application users with its JWT system. The backend creates every liveness session and ties it to the authenticated user.

## Production environment

Add to `/etc/classmark.env`:

```dotenv
AWS_REGION=ap-south-1
REKOGNITION_COLLECTION_ID=classmark-faces
COGNITO_IDENTITY_POOL_ID=ap-south-1:replace-with-real-id
FACE_LIVENESS_THRESHOLD=60
FACE_LIVENESS_CHALLENGE=movement
FACE_MATCH_THRESHOLD=92
FACE_AMBIGUITY_MARGIN=3
```

Restart the service:

```bash
sudo systemctl restart classmark
sudo journalctl -u classmark -n 100 --no-pager
curl https://YOUR_DOMAIN/api/health
```

The health response should contain `"rekognition":true`.

## User workflow

1. User opens **Face recognition** and accepts biometric consent.
2. User completes AWS Face Liveness using the mobile front camera.
3. The backend keeps the confidence score private, indexes the reference image, creates/associates the Rekognition user, and stores only provider IDs in SQLite.
4. A teacher generates a QR attendance session.
5. The teacher opens **Face recognition**, selects that active session, and uses the rear camera to capture one student at a time.
6. Rekognition identifies the face, and the backend verifies classroom membership.
7. Attendance becomes present only after the same session has both QR/location and face verification when Rekognition is configured.

## Deployment/update

```bash
cd /opt/classmark
sudo -u classmark git pull
cd backend
sudo -u classmark npm ci --omit=dev
cd ../frontend
sudo -u classmark npm ci --include=dev
sudo -u classmark npm run build
sudo systemctl restart classmark
sudo systemctl reload nginx
```

Allow the application CSP to connect to `https://*.amazonaws.com` and `wss://*.amazonaws.com`. The Express production fallback already includes these directives. If Nginx sets its own CSP, add the same endpoints there.

## Security and privacy

- Obtain explicit consent before enrollment.
- Keep liveness and match confidence values on the server except for the teacher's supervised recognition result.
- Do not store AWS credentials in React, SQLite, or `.env`.
- Do not store continuous video or every camera frame.
- Provide face-profile deletion and an alternative attendance review path.
- Calibrate thresholds using the actual student population, lighting, cameras, and impostor tests before enabling automatic decisions.
- Set AWS Budgets alerts before real usage.

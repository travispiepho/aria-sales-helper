/**
 * googleDocs.js — Google Docs/Drive export integration
 *
 * Uses the aria-docs-bot service account (credentials injected via the
 * GOOGLE_SERVICE_ACCOUNT_JSON env var, base64-encoded JSON key) to:
 *   1. Create a new Google Doc for a meeting's summary/transcript.
 *   2. Write content into it via batchUpdate.
 *   3. Share it with the requesting user's real Gmail/email address so a
 *      human (not just the service account) can see/edit it in Drive.
 *
 * The private key is decoded in-memory only — never written to disk or logs.
 */

import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
];

let cachedAuth = null;

/**
 * Lazily builds (and caches) a GoogleAuth client from GOOGLE_SERVICE_ACCOUNT_JSON.
 * Throws if the env var is missing/invalid — callers should catch and return
 * a clean 5xx to the client rather than crash the process.
 */
function getAuth() {
  if (cachedAuth) return cachedAuth;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  }

  let credentials;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    credentials = JSON.parse(decoded);
  } catch (err) {
    throw new Error('Failed to decode/parse GOOGLE_SERVICE_ACCOUNT_JSON: ' + err.message);
  }

  cachedAuth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return cachedAuth;
}

/**
 * Creates a Google Doc with the given title, writes the given plain-text
 * content into it, and shares it with shareWithEmail as a writer.
 *
 * @param {string} title - Doc title (e.g. "Meeting Summary — Jane Doe — Aug 4, 2026")
 * @param {string} content - Plain text body to insert into the doc.
 * @param {string} shareWithEmail - Real user email to grant writer access to.
 * @returns {Promise<{ docId: string, webViewLink: string }>}
 */
export async function createMeetingDoc(title, content, shareWithEmail) {
  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // 1. Create the doc
  const createRes = await docs.documents.create({
    requestBody: { title },
  });
  const docId = createRes.data.documentId;
  if (!docId) {
    throw new Error('Google Docs create() did not return a documentId');
  }

  // 2. Insert content (insertText at index 1 — the start of the body)
  if (content && content.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: content,
            },
          },
        ],
      },
    });
  }

  // 3. Share with the requesting user's real email so it shows up in their
  //    own Drive (the service account has no human-visible Drive by default).
  if (shareWithEmail) {
    await drive.permissions.create({
      fileId: docId,
      sendNotificationEmail: false,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: shareWithEmail,
      },
    });
  }

  // 4. Fetch webViewLink to return to the frontend
  const fileRes = await drive.files.get({
    fileId: docId,
    fields: 'id, webViewLink',
  });

  return {
    docId,
    webViewLink: fileRes.data.webViewLink,
  };
}

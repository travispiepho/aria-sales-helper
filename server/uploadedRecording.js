import { createDeepgramSession } from './deepgramSession.js';

export const UPLOADED_RECORDING_CHANNEL = 'uploaded_recording';
export const UPLOADED_RECORDING_PROTOCOL = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  bytesPerSample: 2,
  bytesPerSecond: 32_000,
  maxControlBytes: 4_096,
  maxChunkBytes: 64 * 1024,
  maxDurationSeconds: 8 * 60 * 60,
  paceBurstBytes: 96_000,
});

function protocolError(message, closeCode = 4400) {
  const error = new Error(message);
  error.closeCode = closeCode;
  return error;
}

function parseControlFrame(data) {
  const byteLength = Buffer.byteLength(data);
  if (byteLength > UPLOADED_RECORDING_PROTOCOL.maxControlBytes) {
    throw protocolError('Control frame is too large', 4409);
  }
  let value;
  try {
    value = JSON.parse(data.toString());
  } catch {
    throw protocolError('Malformed JSON control frame');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
    throw protocolError('Control frame must be an object with a type');
  }
  return value;
}

/**
 * Bounded, 1x/no-seek protocol state. The source file never enters this
 * object: callers provide already-decoded 16 kHz mono signed-16-bit PCM.
 */
export function createUploadedRecordingProtocol({ now = () => Date.now() } = {}) {
  let state = 'awaiting_start';
  let declaredBytes = 0;
  let receivedBytes = 0;
  let playbackStartedAtMs = null;
  let pausedAtMs = null;
  let totalPausedMs = 0;

  function elapsedPlaybackMs() {
    if (playbackStartedAtMs === null) return 0;
    const end = pausedAtMs ?? now();
    return Math.max(0, end - playbackStartedAtMs - totalPausedMs);
  }

  return {
    get state() { return state; },
    get receivedBytes() { return receivedBytes; },
    handleControl(raw) {
      if (state === 'ended') throw protocolError('Recording has already ended', 4409);
      const message = parseControlFrame(raw);

      if (message.type === 'start') {
        if (state !== 'awaiting_start') throw protocolError('Duplicate or out-of-order start');
        const durationSeconds = Number(message.durationSeconds);
        if (
          message.encoding !== 'pcm_s16le' ||
          message.sampleRate !== UPLOADED_RECORDING_PROTOCOL.sampleRate ||
          message.channels !== UPLOADED_RECORDING_PROTOCOL.channels ||
          message.playbackRate !== 1 ||
          !Number.isFinite(durationSeconds) ||
          durationSeconds <= 0 ||
          durationSeconds > UPLOADED_RECORDING_PROTOCOL.maxDurationSeconds
        ) {
          throw protocolError('start must declare pcm_s16le, 16000 Hz, mono, playbackRate 1, and a bounded duration');
        }
        declaredBytes = Math.ceil(durationSeconds * UPLOADED_RECORDING_PROTOCOL.bytesPerSecond);
        playbackStartedAtMs = now();
        state = 'streaming';
        return { type: 'started' };
      }

      if (message.type === 'pause') {
        if (state !== 'streaming') throw protocolError('pause is only valid while streaming');
        pausedAtMs = now();
        state = 'paused';
        return { type: 'paused' };
      }

      if (message.type === 'resume') {
        if (state !== 'paused') throw protocolError('resume is only valid while paused');
        totalPausedMs += Math.max(0, now() - pausedAtMs);
        pausedAtMs = null;
        state = 'streaming';
        return { type: 'resumed' };
      }

      if (message.type === 'end') {
        if (state !== 'streaming' && state !== 'paused') throw protocolError('end is out of order');
        if (receivedBytes === 0) throw protocolError('Cannot end before any PCM audio is received');
        state = 'ended';
        return { type: 'ended', receivedBytes };
      }

      throw protocolError(`Unknown control type: ${message.type}`);
    },
    handleBinary(data) {
      if (state === 'ended') throw protocolError('Audio received after end', 4409);
      if (state === 'paused') throw protocolError('Audio is not accepted while paused');
      if (state !== 'streaming') throw protocolError('start metadata is required before audio');
      const buffer = Buffer.from(data);
      if (buffer.byteLength === 0 || buffer.byteLength > UPLOADED_RECORDING_PROTOCOL.maxChunkBytes || buffer.byteLength % 2 !== 0) {
        throw protocolError('PCM chunk must be non-empty, even-length, and no larger than 64 KiB', 4409);
      }
      if (receivedBytes + buffer.byteLength > declaredBytes + UPLOADED_RECORDING_PROTOCOL.maxChunkBytes) {
        throw protocolError('Audio exceeds declared duration', 4409);
      }
      const paceBudget = Math.floor(elapsedPlaybackMs() * UPLOADED_RECORDING_PROTOCOL.bytesPerSecond / 1000)
        + UPLOADED_RECORDING_PROTOCOL.paceBurstBytes;
      if (receivedBytes + buffer.byteLength > paceBudget) {
        throw protocolError('Audio arrived faster than real-time playback pace', 4408);
      }
      receivedBytes += buffer.byteLength;
      return buffer;
    },
  };
}

function safeSend(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function rejectSocket(socket, error) {
  safeSend(socket, { type: 'error', error: error.message });
  socket.close(error.closeCode || 4400, error.message.slice(0, 120));
}

function transcriptLabel(result) {
  const speaker = Number.isInteger(result.speaker) && result.speaker >= 0 ? result.speaker : 0;
  return `Speaker ${speaker + 1}`;
}

/** Register the authenticated creation + owner-bound upload-stream contract. */
export async function registerUploadedRecordingRoutes(fastify, {
  pool,
  requireAuth,
  authWebSocketWithSession,
  apiKey,
  createTranscriptionSession = createDeepgramSession,
  broadcastToMeeting = () => {},
  registerMeetingSocket = () => {},
  unregisterMeetingSocket = () => {},
  runCoachingAnalysis = async () => null,
  finalizeMeeting,
  now = () => Date.now(),
  transcriptDrainMs = 2_100,
} = {}) {
  if (!pool || !requireAuth || !authWebSocketWithSession || !finalizeMeeting) {
    throw new Error('uploaded recording routes require pool, auth, and finalization dependencies');
  }

  fastify.post('/api/uploaded-recordings', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!apiKey) return reply.code(503).send({ error: 'Transcription is not configured' });
    const { customer_id = null, durationSeconds } = request.body || {};
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > UPLOADED_RECORDING_PROTOCOL.maxDurationSeconds) {
      return reply.code(400).send({ error: `durationSeconds must be between 0 and ${UPLOADED_RECORDING_PROTOCOL.maxDurationSeconds}` });
    }
    const ownerSessionId = request.cookies?.session_id || null;
    if (!ownerSessionId) return reply.code(401).send({ error: 'Unauthorized' });

    const result = await pool.query(
      `INSERT INTO meetings (customer_id, rep_id, status, owner_session_id, origin_client, channel)
       VALUES ($1, $2, 'active', $3, 'web', $4)
       RETURNING *`,
      [customer_id, request.user.id, ownerSessionId, UPLOADED_RECORDING_CHANNEL],
    );
    const meeting = result.rows[0];
    return reply.code(201).send({
      id: meeting.id,
      customer_id: meeting.customer_id,
      rep_id: meeting.rep_id,
      status: meeting.status,
      started_at: meeting.started_at,
      origin_client: meeting.origin_client,
      channel: UPLOADED_RECORDING_CHANNEL,
      meeting_type: UPLOADED_RECORDING_CHANNEL,
      upload_ws_path: `/meetings/${meeting.id}/uploaded-recording`,
      upload_protocol: {
        encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, playbackRate: 1,
        maxChunkBytes: UPLOADED_RECORDING_PROTOCOL.maxChunkBytes,
      },
    });
  });

  fastify.get('/meetings/:meetingId/uploaded-recording', { websocket: true }, async (socket, request) => {
    const { meetingId } = request.params;
    const { user, sessionId } = await authWebSocketWithSession(request);
    if (!user) return rejectSocket(socket, protocolError('Unauthorized', 4001));
    if (!apiKey) return rejectSocket(socket, protocolError('Transcription is not configured', 1011));

    let meeting;
    try {
      const result = await pool.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
      meeting = result.rows[0];
    } catch (error) {
      fastify.log.error(`uploaded recording meeting lookup failed: ${error.message}`);
      return rejectSocket(socket, protocolError('Internal error', 1011));
    }
    if (!meeting) return rejectSocket(socket, protocolError('Meeting not found', 4004));
    if (
      meeting.rep_id !== user.id ||
      !meeting.owner_session_id ||
      meeting.owner_session_id !== sessionId
    ) return rejectSocket(socket, protocolError('Forbidden', 4003));
    if (meeting.channel !== UPLOADED_RECORDING_CHANNEL || meeting.status !== 'active') {
      return rejectSocket(socket, protocolError('Meeting is not an active uploaded recording', 4003));
    }

    const protocol = createUploadedRecordingProtocol({ now });
    let closed = false;
    let ending = false;
    let transcription = null;
    let persistQueue = Promise.resolve();
    let finalSegmentCount = 0;
    let coachingInFlight = null;

    registerMeetingSocket(meetingId, socket);

    const queueTranscript = (result) => {
      if (closed || !result?.text) return;
      const speaker = transcriptLabel(result);
      if (!result.isFinal) {
        broadcastToMeeting(meetingId, { type: 'interim', text: result.text, speaker });
        return;
      }
      persistQueue = persistQueue.then(async () => {
        const words = Array.isArray(result.words) ? result.words : [];
        const durationMs = words.length && Number.isFinite(words[0]?.start) && Number.isFinite(words.at(-1)?.end)
          ? Math.max(0, Math.round((words.at(-1).end - words[0].start) * 1000)) : null;
        const inserted = await pool.query(
          `INSERT INTO transcript_segments (meeting_id, ts, speaker, text, word_count, duration_ms)
           VALUES ($1, NOW(), $2, $3, $4, $5) RETURNING id, ts`,
          [meetingId, speaker, result.text, words.length || result.text.split(/\s+/).filter(Boolean).length, durationMs],
        );
        finalSegmentCount += 1;
        broadcastToMeeting(meetingId, {
          type: 'final', id: inserted.rows[0]?.id, ts: inserted.rows[0]?.ts,
          text: result.text, speaker,
        });
        // Keep transcript persistence real-time. Coaching is intentionally
        // non-blocking and capped at one request at a time; otherwise a long
        // recording could queue one paid model call per utterance and delay
        // terminal finalization behind the entire call chain.
        if (finalSegmentCount >= 3 && finalSegmentCount % 3 === 0 && !coachingInFlight) {
          coachingInFlight = Promise.resolve(runCoachingAnalysis(meetingId))
            .then((coaching) => {
              if (coaching) broadcastToMeeting(meetingId, { type: 'coaching', data: coaching });
            })
            .catch((error) => {
              fastify.log.error(`uploaded recording coaching failed: ${error.message}`);
            })
            .finally(() => { coachingInFlight = null; });
        }
      }).catch((error) => {
        fastify.log.error(`uploaded recording transcript persistence failed: ${error.message}`);
        safeSend(socket, { type: 'error', error: 'Transcript persistence failed' });
      });
    };

    try {
      transcription = createTranscriptionSession({
        apiKey,
        onTranscript: queueTranscript,
        onCircuitOpen: (reason) => safeSend(socket, { type: 'transcription_lapse', state: 'stopped', reason }),
        onLapseStart: () => safeSend(socket, { type: 'transcription_lapse', state: 'reconnecting' }),
        onLapseEnd: () => safeSend(socket, { type: 'transcription_lapse', state: 'recovered' }),
        onError: (error) => fastify.log.error(`uploaded recording transcription error: ${error.message}`),
        log: (message) => fastify.log.info(`uploaded recording ${meetingId}: ${message}`),
      });
    } catch (error) {
      unregisterMeetingSocket(meetingId, socket);
      return rejectSocket(socket, protocolError('Could not start transcription', 1011));
    }

    const complete = async () => {
      if (ending) throw protocolError('Completion is already in progress', 4409);
      ending = true;
      transcription.close();
      if (transcriptDrainMs > 0) await new Promise((resolve) => {
        const timer = setTimeout(resolve, transcriptDrainMs);
        timer.unref?.();
      });
      await persistQueue;
      if (coachingInFlight) await coachingInFlight;
      const completion = await finalizeMeeting(meetingId);
      broadcastToMeeting(meetingId, { type: 'meeting_ended', meetingId, status: 'completed' });
      safeSend(socket, { type: 'completed', meetingId, summary: completion?.summary ?? null });
      socket.close(1000, 'Completed');
    };

    socket.on('message', (data, isBinary) => {
      if (closed) return;
      try {
        if (ending) throw protocolError('Recording has already ended', 4409);
        if (isBinary) {
          const pcm = protocol.handleBinary(data);
          transcription.send(pcm);
          return;
        }
        const event = protocol.handleControl(data);
        safeSend(socket, event);
        if (event.type === 'ended') complete().catch((error) => {
          fastify.log.error(`uploaded recording completion failed: ${error.message}`);
          rejectSocket(socket, protocolError('Completion failed', 1011));
        });
      } catch (error) {
        rejectSocket(socket, error);
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unregisterMeetingSocket(meetingId, socket);
      if (!ending) {
        transcription?.close();
        pool.query(
          `UPDATE meetings SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW())
           WHERE id = $1 AND status = 'active'`,
          [meetingId],
        ).catch((error) => fastify.log.error(`uploaded recording interruption update failed: ${error.message}`));
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

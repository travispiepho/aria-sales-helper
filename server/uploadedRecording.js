import { createDeepgramSession } from './deepgramSession.js';
import {
  createInPersonIntroductionLabeler,
  isEligibleInPersonMeeting,
  persistIntroductionResolution,
} from './inPersonIntroductionLabels.js';
import { createFirst30SpeakerRepairCoordinator } from './first30SpeakerRepair.js';

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
  maxSetupQueuedFrames: 16,
  maxSetupQueuedBytes: 256 * 1024,
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

      // Application heartbeat keeps a legitimately paused browser/server
      // stream from looking idle to intermediaries. It carries no playback
      // position and intentionally changes neither pace nor pause accounting.
      if (message.type === 'heartbeat') {
        if (state !== 'streaming' && state !== 'paused') throw protocolError('heartbeat is only valid after start and before end');
        return { type: 'heartbeat' };
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
  registerSpeakerController = () => {},
  unregisterSpeakerController = () => {},
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
    const setupFrames = [];
    let setupQueuedBytes = 0;
    let setupClosed = false;
    let dispatchFrame = null;

    const discardSetupFrames = () => {
      setupFrames.length = 0;
      setupQueuedBytes = 0;
    };
    const stopSetup = () => {
      setupClosed = true;
      discardSetupFrames();
    };
    const rejectDuringSetup = (error) => {
      if (setupClosed) return;
      stopSetup();
      rejectSocket(socket, error);
    };
    const queueOrDispatchFrame = (data, isBinary) => {
      if (setupClosed) return;
      if (dispatchFrame) return dispatchFrame(data, isBinary);

      const retained = Buffer.from(data);
      if (
        setupFrames.length >= UPLOADED_RECORDING_PROTOCOL.maxSetupQueuedFrames ||
        setupQueuedBytes + retained.byteLength > UPLOADED_RECORDING_PROTOCOL.maxSetupQueuedBytes
      ) {
        return rejectDuringSetup(protocolError('Too much recording data arrived during setup', 4409));
      }
      setupFrames.push({ data: retained, isBinary });
      setupQueuedBytes += retained.byteLength;
    };

    // Fastify does not buffer application messages while an async WebSocket
    // route awaits. Attach synchronously so start/audio sent on browser open
    // cannot disappear during auth, lookup, or transcription construction.
    socket.on('message', queueOrDispatchFrame);
    socket.on('close', stopSetup);
    socket.on('error', stopSetup);

    let auth;
    try {
      auth = await authWebSocketWithSession(request);
    } catch (error) {
      fastify.log.error(`uploaded recording authentication failed: ${error.message}`);
      return rejectDuringSetup(protocolError('Internal error', 1011));
    }
    if (setupClosed) return;
    const { user, sessionId } = auth || {};
    if (!user) return rejectDuringSetup(protocolError('Unauthorized', 4001));
    if (!apiKey) return rejectDuringSetup(protocolError('Transcription is not configured', 1011));

    let meeting;
    try {
      const result = await pool.query(
        `SELECT m.*, c.name AS customer_name
         FROM meetings m LEFT JOIN customers c ON m.customer_id = c.id
         WHERE m.id = $1`,
        [meetingId],
      );
      meeting = result.rows[0];
    } catch (error) {
      fastify.log.error(`uploaded recording meeting lookup failed: ${error.message}`);
      return rejectDuringSetup(protocolError('Internal error', 1011));
    }
    if (setupClosed) return;
    if (!meeting) return rejectDuringSetup(protocolError('Meeting not found', 4004));
    if (
      meeting.rep_id !== user.id ||
      !meeting.owner_session_id ||
      meeting.owner_session_id !== sessionId
    ) return rejectDuringSetup(protocolError('Forbidden', 4003));
    if (meeting.channel !== UPLOADED_RECORDING_CHANNEL || meeting.status !== 'active') {
      return rejectDuringSetup(protocolError('Meeting is not an active uploaded recording', 4003));
    }

    const protocol = createUploadedRecordingProtocol({ now });
    let closed = false;
    let ending = false;
    let transcription = null;
    let persistQueue = Promise.resolve();
    let finalSegmentCount = 0;
    let coachingInFlight = null;
    const speakerLocks = {};
    const speakerLockSources = {};
    for (const [speakerId, name] of Object.entries(meeting.speaker_labels || {})) {
      const parsed = /^Speaker\s+(\d+)$/i.exec(speakerId);
      if (!parsed || !String(name || '').trim()) continue;
      const si = String(Number(parsed[1]) - 1);
      speakerLocks[si] = String(name).trim();
      speakerLockSources[si] = meeting.speaker_label_evidence?.[si]?.method === 'introduction' ? 'introduction' : 'manual';
    }

    const first30Repair = createFirst30SpeakerRepairCoordinator({
      pool, meeting, meetingId, repName: user.name, customerName: meeting.customer_name || null,
      broadcastToMeeting,
      onSlotLabels: (slotLabels, result) => {
        meeting.speaker_labels = result.speakerLabels || meeting.speaker_labels;
        meeting.speaker_label_evidence = result.speakerLabelEvidence || meeting.speaker_label_evidence;
        for (const [si, label] of Object.entries(slotLabels)) {
          if (speakerLockSources[si] === 'manual') continue;
          speakerLocks[si] = label.name;
          speakerLockSources[si] = 'first30_contextual_repair';
        }
      },
      logger: (message) => fastify.log.error(`uploaded first30 repair ${meetingId}: ${message}`),
    });

    const introductionLabeler = createInPersonIntroductionLabeler({
      meetingType: isEligibleInPersonMeeting(meeting) ? meeting.channel : 'excluded',
      repDisplayName: user.name,
      customerDisplayName: meeting.customer_name || null,
      startedAtMs: new Date(meeting.started_at || now()).getTime(),
      now,
      existingLocks: Object.fromEntries(
        Object.entries(speakerLocks).map(([si, name]) => [si, { name, source: speakerLockSources[si] }]),
      ),
      existingEvidence: meeting.speaker_label_evidence || {},
      onConflict: (conflict) => fastify.log.warn(`uploaded recording introduction conflict for ${meetingId}: ${JSON.stringify(conflict)}`),
      resolveIdentity: async ({ speakerIndex, name, role, evidence }) => {
        const si = String(speakerIndex);
        const current = speakerLocks[si];
        if (current) return { resolved: false, reason: current === name ? 'idempotent' : 'locked' };
        speakerLocks[si] = name;
        speakerLockSources[si] = 'introduction_pending';
        let resolution;
        try {
          resolution = await persistIntroductionResolution({ pool, meetingId, speakerIndex, name, evidence });
        } catch (error) {
          delete speakerLocks[si];
          delete speakerLockSources[si];
          throw error;
        }
        if (!resolution.resolved) {
          delete speakerLocks[si];
          delete speakerLockSources[si];
          return resolution;
        }
        meeting.speaker_labels = resolution.speakerLabels;
        meeting.speaker_label_evidence = resolution.speakerLabelEvidence;
        first30Repair.setKnownIdentity(role, name);
        speakerLocks[si] = name;
        speakerLockSources[si] = 'introduction';
        broadcastToMeeting(meetingId, {
          type: 'speaker_lock', speakerId: `Speaker ${speakerIndex + 1}`,
          name, role, source: 'introduction', confidence: evidence.confidence,
        });
        return { resolved: true };
      },
    });

    const speakerController = {
      manualLock(speakerId, name) {
        const parsed = /^Speaker\s+(\d+)$/i.exec(String(speakerId || ''));
        const display = String(name || '').trim();
        if (!parsed || !display) return { ok: false };
        const si = String(Number(parsed[1]) - 1);
        speakerLocks[si] = display;
        speakerLockSources[si] = 'manual';
        introductionLabeler.setManualLock(si, display);
        return { ok: true, locked: display };
      },
    };

    registerMeetingSocket(meetingId, socket);
    registerSpeakerController(meetingId, speakerController);

    const queueTranscript = (result) => {
      if (closed || !result?.text) return;
      const speakerIndex = Number.isInteger(result.speaker) && result.speaker >= 0 ? result.speaker : 0;
      const speakerId = transcriptLabel(result);
      const speaker = first30Repair.labelForSegment({
        speakerIndex, text: result.text,
        defaultLabel: speakerLocks[String(speakerIndex)] || speakerId,
      });
      if (!result.isFinal) {
        broadcastToMeeting(meetingId, { type: 'interim', text: result.text, speaker });
        return;
      }
      persistQueue = persistQueue.then(async () => {
        const words = Array.isArray(result.words) ? result.words : [];
        const durationMs = words.length && Number.isFinite(words[0]?.start) && Number.isFinite(words.at(-1)?.end)
          ? Math.max(0, Math.round((words.at(-1).end - words[0].start) * 1000)) : null;
        const timedWords = words.filter(word => Number.isFinite(word?.start) && Number.isFinite(word?.end));
        const mediaStartMs = timedWords.length > 0 ? first30Repair.mediaOffsetMs(timedWords[0].start) : null;
        const mediaEndMs = timedWords.length > 0 ? first30Repair.mediaOffsetMs(timedWords.at(-1).end) : null;
        const inserted = await pool.query(
          `INSERT INTO transcript_segments
             (meeting_id, ts, speaker, text, word_count, duration_ms, media_start_ms, media_end_ms, speaker_slot)
           VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8) RETURNING id, ts`,
          [meetingId, speaker, result.text, words.length || result.text.split(/\s+/).filter(Boolean).length,
            durationMs, mediaStartMs, mediaEndMs, speakerIndex],
        );
        const insertedId = inserted.rows[0]?.id;
        const insertedTs = inserted.rows[0]?.ts;
        if (insertedId && introductionLabeler.enabled) {
          try {
            await introductionLabeler.onSegment({
              id: insertedId, speakerIndex, text: result.text, ts: insertedTs,
              // The upload protocol's injected clock tracks playback progress;
              // DB insertion time can lag or be independently stubbed.
              timestampMs: now(),
            });
          } catch (error) {
            fastify.log.error(`uploaded recording introduction labeling failed: ${error.message}`);
          }
        }
        finalSegmentCount += 1;
        broadcastToMeeting(meetingId, {
          type: 'final', id: insertedId, ts: insertedTs,
          text: result.text, speaker,
        });
        if (insertedId) await first30Repair.afterSegmentPersisted();
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
        onAudioAccepted: (byteLength) => first30Repair.noteAcceptedMediaBytes(byteLength),
        onCircuitOpen: (reason) => safeSend(socket, { type: 'transcription_lapse', state: 'stopped', reason }),
        onLapseStart: () => safeSend(socket, { type: 'transcription_lapse', state: 'reconnecting' }),
        onLapseEnd: () => safeSend(socket, { type: 'transcription_lapse', state: 'recovered' }),
        onError: (error) => fastify.log.error(`uploaded recording transcription error: ${error.message}`),
        log: (message) => fastify.log.info(`uploaded recording ${meetingId}: ${message}`),
      });
    } catch (error) {
      unregisterMeetingSocket(meetingId, socket);
      unregisterSpeakerController(meetingId, speakerController);
      return rejectDuringSetup(protocolError('Could not start transcription', 1011));
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
      await first30Repair.flush();
      let completion;
      try {
        completion = await finalizeMeeting(meetingId);
      } catch (error) {
        // Uploaded-recording finalization marks the meeting completed before
        // optional summary/sync/title follow-ups run. If one of those throws,
        // do not turn the already-terminal meeting into a false protocol
        // failure. Confirm the persisted status first; an active (or
        // unreadable) meeting still follows the genuine failure path below.
        let status = null;
        try {
          const result = await pool.query('SELECT status FROM meetings WHERE id = $1', [meetingId]);
          status = result.rows[0]?.status ?? null;
        } catch (statusError) {
          fastify.log.error(`uploaded recording completion status readback failed: ${statusError.message}`);
        }
        if (status !== 'completed') throw error;
        fastify.log.error(`uploaded recording non-critical follow-up failed after meeting completed: ${error.message}`);
        completion = null;
      }

      // Once finalization is persisted, broadcasts, the acknowledgement send,
      // and close ordering are all best-effort follow-ups. None may emit a
      // contradictory "Completion failed" frame for a completed meeting.
      try {
        broadcastToMeeting(meetingId, { type: 'meeting_ended', meetingId, status: 'completed' });
      } catch (error) {
        fastify.log.error(`uploaded recording completion broadcast failed: ${error.message}`);
      }
      try {
        safeSend(socket, { type: 'completed', meetingId, summary: completion?.summary ?? null });
      } catch (error) {
        fastify.log.error(`uploaded recording completion acknowledgement failed: ${error.message}`);
      }
      try {
        socket.close(1000, 'Completed');
      } catch (error) {
        fastify.log.error(`uploaded recording completion socket close failed: ${error.message}`);
      }
    };

    dispatchFrame = (data, isBinary) => {
      if (closed || setupClosed) return;
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
        setupClosed = true;
        discardSetupFrames();
        rejectSocket(socket, error);
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unregisterMeetingSocket(meetingId, socket);
      unregisterSpeakerController(meetingId, speakerController);
      if (!ending) {
        transcription?.close();
        pool.query(
          `UPDATE meetings SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW())
           WHERE id = $1 AND status = 'active'`,
          [meetingId],
        ).catch((error) => fastify.log.error(`uploaded recording interruption update failed: ${error.message}`));
      }
    };
    socket.off('close', stopSetup);
    socket.off('error', stopSetup);
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    const retainedSetupFrames = setupFrames.splice(0);
    setupQueuedBytes = 0;
    for (const frame of retainedSetupFrames) {
      if (closed || setupClosed) break;
      dispatchFrame(frame.data, frame.isBinary);
    }
  });
}

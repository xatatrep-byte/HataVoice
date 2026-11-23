/**
 * The call's encryption worker: LiveKit's own, patched (patches/livekit-client@2.23.0.patch) to encrypt AV1 whole and
 * carry it in an OBU envelope its RTP packer can cut — the envelope is made and opened here (see av1Envelope.ts).
 */
import { unwrapAv1, wrapAv1 } from "./av1Envelope";
import "livekit-client/e2ee-worker";

// Read by the patched worker when an AV1 frame comes, long after this module ran.
(globalThis as { __hvAv1?: unknown }).__hvAv1 = { wrap: wrapAv1, unwrap: unwrapAv1 };

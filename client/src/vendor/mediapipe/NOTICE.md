# MediaPipe Tasks Vision

Pose and face tracking for «Движения персонажа» → «С камеры». Everything runs on this PC: no frame leaves it.

- Library: `@mediapipe/tasks-vision` 1.2.0 from registry.npmjs.org (Google), Apache License 2.0,
  tarball sha512 `7+dr9GbGyTtcuLh11wE5TOn4dNFRncIT9oAWs72620WX99KW5FfzF6rFJ/ChTgXG9vJ6dCiE9FrEEY4CnwPWKQ==`.
  Here: `vision_bundle.mjs` and its types (`vision.d.ts` as `vision_bundle.d.mts`); in `public/mediapipe`:
  `vision_wasm_internal.js` and `vision_wasm_internal.wasm` (sha256 `bcc13df22d3d69ec8cbe8e280989356d844ae00f4523eb82072d2484f44134dc`).
- Models (Apache License 2.0), from storage.googleapis.com/mediapipe-models:
  `pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` (sha256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`),
  `face_landmarker/face_landmarker/float16/1/face_landmarker.task` (sha256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`).

**One change to the library:** it keeps a usage log and posts it to `https://odml.pa.googleapis.com/v1/log` (a Google
API). That post is cut out: in `vision_bundle.mjs` the call is `(t?.(),0)&&this.o.send({url:"https://odml.pa.googleapis.com/v1/log",…`,
so the log is dropped and nothing is sent; the production build drops the whole call as dead code, so the address is not in it at all. The window's CSP would block it anyway (`connect-src` has no such host).
Redo this change after any update and check that `grep -c odml.pa.googleapis.com` finds only the cut-out call.

The loader adds `vision_wasm_internal.js` as a same-origin script and compiles the wasm: the window's CSP allows it
(`script-src 'self' 'wasm-unsafe-eval'`). To update, take a stable version at least two weeks old and replace all files.

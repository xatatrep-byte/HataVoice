// What Tauri gives a page in its web view, for a page in a browser (see front.rs): `invoke` and events go over the pipe to
// the hidden window. The rest of the program does not know the difference.
(() => {
  const SECRET = "__SECRET__";
  const socket = new WebSocket(`ws://${location.host}/${SECRET}/pipe?side=page`);
  socket.binaryType = "arraybuffer";

  let opened = false;
  const unsent = [];
  const send = (message, bytes) => {
    if (!opened) {
      unsent.push([message, bytes]);
      return;
    }
    socket.send(JSON.stringify(message));
    if (bytes) socket.send(bytes);
  };
  socket.onopen = () => {
    opened = true;
    for (const [message, bytes] of unsent.splice(0)) send(message, bytes);
  };
  // The program ended.
  socket.onclose = () => window.close();

  const answers = new Map();
  const callbacks = new Map();
  let nextId = 1;
  let binaryFor = null;

  const settle = (id, ok, err, failed) => {
    const answer = answers.get(id);
    if (!answer) return;
    answers.delete(id);
    if (failed) answer.reject(err);
    else answer.resolve(ok);
  };

  socket.onmessage = ({ data }) => {
    if (data instanceof ArrayBuffer) {
      settle(binaryFor, data);
      binaryFor = null;
      return;
    }
    const message = JSON.parse(data);
    if (message.fire !== undefined) callbacks.get(message.fire)?.(message.payload);
    else if (message.binary) binaryFor = message.id;
    else settle(message.id, message.ok, message.err, "err" in message);
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    callbacks,
    transformCallback(callback, once = false) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0];
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        callback?.(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    runCallback(id, payload) {
      callbacks.get(id)?.(payload);
    },
    convertFileSrc(path, protocol = "asset") {
      return protocol === "hvmedia" ? `${location.origin}/${SECRET}/hvmedia/${encodeURIComponent(path)}` : path;
    },
    invoke(cmd, args = {}, options) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        answers.set(id, { resolve, reject });
        const bytes = args instanceof ArrayBuffer ? args : ArrayBuffer.isView(args) ? args.buffer.slice(args.byteOffset, args.byteOffset + args.byteLength) : null;
        send(bytes ? { id, cmd, options, binary: true } : { id, cmd, args, options }, bytes);
      });
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__HV_MEDIA__ = `${location.origin}/${SECRET}/hvmedia`;
  window.isTauri = true;
})();

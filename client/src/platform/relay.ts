/**
 * Linux: the window is a browser, and this hidden web view does for it what a page in a browser cannot, calling the program
 * (see `front.rs`). It draws nothing and knows nothing of what passes through it.
 */

type Internals = {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
};

type Asked = { id: number; cmd: string; args?: unknown; options?: unknown; binary?: boolean };

export type Sender = {
  send: (data: string | ArrayBuffer) => void;
};

/** One end of the pipe, apart from the socket so that it can be tested. */
export function makeRelay(internals: Internals, socket: Sender) {
  const listeners: { event: string; eventId: unknown; callback: number }[] = [];
  let binaryFor: Asked | null = null;

  const answer = (id: number, result: unknown) => {
    if (result instanceof ArrayBuffer) {
      socket.send(JSON.stringify({ id, binary: true }));
      socket.send(result);
    } else {
      socket.send(JSON.stringify({ id, ok: result }));
    }
  };

  const run = async (asked: Asked, args: unknown) => {
    try {
      answer(asked.id, await internals.invoke(asked.cmd, args, asked.options));
    } catch (error) {
      socket.send(JSON.stringify({ id: asked.id, err: error }));
    }
  };

  const listen = async (asked: Asked) => {
    const { event, target, handler } = asked.args as { event: string; target: unknown; handler: number };
    const callback = internals.transformCallback((payload) => socket.send(JSON.stringify({ fire: handler, payload })));
    try {
      const eventId = await internals.invoke("plugin:event|listen", { event, target, handler: callback });
      listeners.push({ event, eventId, callback });
      answer(asked.id, eventId);
    } catch (error) {
      internals.unregisterCallback(callback);
      socket.send(JSON.stringify({ id: asked.id, err: error }));
    }
  };

  return {
    onMessage(data: string | ArrayBuffer) {
      if (data instanceof ArrayBuffer) {
        if (binaryFor) void run(binaryFor, data);
        binaryFor = null;
        return;
      }
      const message = JSON.parse(data) as Asked & { pageGone?: boolean };
      if (message.pageGone) {
        for (const { event, eventId, callback } of listeners.splice(0)) {
          internals.unregisterCallback(callback);
          void internals.invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
        }
      } else if (message.binary) {
        binaryFor = message;
      } else if (message.cmd === "plugin:event|listen") {
        void listen(message);
      } else {
        void run(message, message.args);
      }
    },
  };
}

export function runRelay({ port, secret }: { port: number; secret: string }) {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/${secret}/pipe?side=relay`);
  socket.binaryType = "arraybuffer";
  const relay = makeRelay(internals, socket);
  socket.onmessage = ({ data }) => relay.onMessage(data as string | ArrayBuffer);
}

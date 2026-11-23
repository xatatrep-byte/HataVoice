import type { ChannelView } from "../../server/session";

/** A room of direct messages as a channel the chat view shows: named after the other one. */
export function dmChannel(room: string, peerName: string): ChannelView {
  return {
    id: room,
    name: peerName,
    user_limit: 0,
    people: [],
    access: { view: true, connect: false, speak: false },
    overrides: [],
    kind: "text",
    closed: false,
  };
}

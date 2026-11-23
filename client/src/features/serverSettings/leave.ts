import { postEntry } from "../../server/session";
import { useServers } from "../../state/servers";

/** Writes `Leave` and drops the server from the list; coming back takes a new invite. */
export async function leaveServer(address: string): Promise<void> {
  await postEntry(address, { type: "leave" });
  useServers.getState().remove(address);
}

import { useHost } from "../../host/useHost";
import { DeleteServerZone } from "../host/DeleteServerDialog";
import { EntryWays } from "../host/EntryWays";
import "../host/host.css";

/** «Подключение»: how friends get to the server on this PC, and deleting it. For its owner, on that PC only. */
export function ConnectionTab({ name, address, onDeleted }: { name: string; address: string; onDeleted: () => void }) {
  const host = useHost();
  if (!host.view?.config) return <p className="hint">Узнаю, как устроен сервер на этом ПК…</p>;
  return (
    <div className="connection-tab">
      <EntryWays host={host} />
      <DeleteServerZone name={name} address={address} onDeleted={onDeleted} />
    </div>
  );
}

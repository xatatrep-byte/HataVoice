import { CAN_HOST, THIS_DEVICE } from "../../platform";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { DEFAULT_HOST_CONFIG, type HostConfig } from "../../host/types";
import { IconButton } from "../../ui/IconButton";
import { SERVER_TEXT, connectServer, isInviteLink, normalizeAddress, serverErrorText } from "../../server/session";
import { useBackupPrompt } from "../../state/backup";
import { randomServerColor, useServers } from "../../state/servers";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { notify } from "../../ui/toasts";
import { MAX_ROOM_NAME, MAX_ROOMS, roomsFromNames } from "../channels/templates";
import { createHostedServer, hostView, localAddress, type NewServer } from "../host/createServer";
import { DeleteServerDialog } from "../host/DeleteServerDialog";
import { portTrouble } from "../host/entryState";
import { JoinScreen } from "../join/JoinScreen";

type Tab = "connect" | "create";

type Props = {
  open: boolean;
  onClose: () => void;
  initialTab?: Tab;
  /** An invite opened from outside (browser, messenger): goes straight to the join screen. */
  initialLink?: string | null;
};

const STRANGER_TEXT = "На сервер заходят только по приглашениям. Попроси ссылку у владельца";

function ConnectTab({ onDone, initialLink }: { onDone: () => void; initialLink?: string | null }) {
  const add = useServers((s) => s.add);
  const select = useServers((s) => s.select);
  const [target, setTarget] = useState("");
  const [joinLink, setJoinLink] = useState<string | null>(initialLink ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (joinLink) {
    return (
      <JoinScreen
        link={joinLink}
        onCancel={() => setJoinLink(null)}
        onJoined={(joined) => {
          notify.info(`Ты на сервере «${joined.name}»`);
          onDone();
        }}
      />
    );
  }

  async function connect() {
    const text = isInviteLink(target) ? target.trim() : normalizeAddress(target);
    if (!text) {
      setError("Вставь ссылку-приглашение от друга");
      return;
    }
    if (isInviteLink(text)) {
      setJoinLink(text);
      return;
    }
    // A plain address works only for servers we already belong to (or our own).
    setBusy(true);
    setError(null);
    try {
      const opened = await connectServer(text);
      add({ address: text, name: opened.name || text, color: randomServerColor(), serverKey: opened.serverKey });
      select(text);
      if (opened.backupSuggested) useBackupPrompt.getState().show();
      notify.info("Сервер добавлен");
      onDone();
    } catch (e) {
      const message = serverErrorText(e);
      setError(message === SERVER_TEXT.joinNeeded ? STRANGER_TEXT : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor="add-address">
          Ссылка-приглашение или адрес
        </label>
        <input
          id="add-address"
          className="input"
          autoFocus
          value={target}
          spellCheck={false}
          placeholder="hatavoice://…"
          onChange={(e) => {
            setTarget(e.currentTarget.value);
            setError(null);
          }}
        />
        <span className="hint">Ссылку даёт владелец сервера или тот, кому он разрешил приглашать</span>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Подключаюсь…" : "Подключиться"}
        </Button>
      </div>
    </form>
  );
}

const PORT_FIELDS: { key: "api_port" | "rtc_udp_port" | "rtc_tcp_port"; label: string }[] = [
  { key: "api_port", label: "Порт сервера (TCP)" },
  { key: "rtc_udp_port", label: "Порт голоса (UDP)" },
  { key: "rtc_tcp_port", label: "Порт голоса через TCP" },
];

/** What a server already on this PC is: its name in the list and how to reach it here. */
type Existing = { name: string; address: string; config: HostConfig };

function CreateTab({ onDone }: { onDone: () => void }) {
  const add = useServers((s) => s.add);
  const select = useServers((s) => s.select);
  const servers = useServers((s) => s.servers);
  const [name, setName] = useState("Мой сервер");
  const [rooms, setRooms] = useState<string[]>(["Общий"]);
  const [newRoom, setNewRoom] = useState("");
  // Shown only after a start failed on a port someone else holds.
  const [portsShown, setPortsShown] = useState(false);
  const [ports, setPorts] = useState({ api_port: DEFAULT_HOST_CONFIG.api_port, rtc_udp_port: DEFAULT_HOST_CONFIG.rtc_udp_port, rtc_tcp_port: DEFAULT_HOST_CONFIG.rtc_tcp_port });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<Existing | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    void hostView()
      .then((view) => {
        if (!view.config) return;
        const address = localAddress(view.config);
        setExisting({ name: servers.find((s) => s.address === address)?.name ?? view.config.name, address, config: view.config });
      })
      .catch(() => {});
    // Looked up once, when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isTauri()) {
    return <p className="hint">Создать свой сервер можно только в приложении для Windows.</p>;
  }

  /** Starts the server (made now, or already here), makes this PC its owner and opens it. */
  async function start(server: NewServer) {
    setBusy(true);
    setError(null);
    try {
      const created = await createHostedServer(server);
      const address = localAddress(created.config);
      const known = useServers.getState().servers.find((s) => s.address === address);
      add({ address, name: known?.name ?? created.config.name, color: known?.color ?? randomServerColor(), serverKey: created.serverKey });
      select(address);
      notify.info(existing ? "Сервер открыт" : "Сервер создан и работает");
      if (created.backupSuggested) useBackupPrompt.getState().show();
      onDone();
    } catch (e) {
      const text = String(e);
      setError(text);
      if (!existing && portTrouble(text)) setPortsShown(true);
    } finally {
      setBusy(false);
    }
  }

  if (existing) {
    const { config } = existing;
    return (
      <div className="create-server">
        <div className="existing-server">
          <strong>На {THIS_DEVICE} уже есть твой сервер «{existing.name}»</strong>
          <span className="hint">Здесь может быть только один свой сервер. Открой его или удали, чтобы начать с чистого листа.</span>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <Button variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
            <Trash2 size={15} aria-hidden /> Удалить и создать новый
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void start({ name: config.name, rooms: roomsFromNames(["Общий"]), upnp: config.upnp, p2p: config.p2p !== false })
            }
          >
            {busy ? "Запускаю сервер…" : "Открыть его"}
          </Button>
        </div>
        <DeleteServerDialog open={deleting} name={existing.name} address={existing.address} onClose={() => setDeleting(false)} onDeleted={() => setExisting(null)} />
      </div>
    );
  }

  const addRoom = () => {
    const room = newRoom.trim();
    if (!room) return;
    if (rooms.some((r) => r.trim().toLowerCase() === room.toLowerCase())) {
      setError(`Комната «${room}» уже есть`);
      return;
    }
    setRooms([...rooms, room].slice(0, MAX_ROOMS));
    setNewRoom("");
    setError(null);
  };
  const moveRoom = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rooms.length) return;
    const next = [...rooms];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRooms(next);
  };

  function create() {
    if (!name.trim()) {
      setError("Введи название сервера");
      return;
    }
    const list = roomsFromNames(newRoom.trim() ? [...rooms, newRoom] : rooms);
    if (list.length === 0) {
      setError("Нужна хотя бы одна комната");
      return;
    }
    const used = Object.values(ports);
    if (used.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(used).size !== used.length) {
      setError("Порты — разные числа от 1024 до 65535");
      return;
    }
    // Both ways in from the start: the app finds the one that works for each friend.
    void start({ name, rooms: list, upnp: true, p2p: true, ports: portsShown ? ports : undefined });
  }

  return (
    <form
      className="create-server"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor="create-name">
          Название
        </label>
        <input id="create-name" className="input" value={name} maxLength={48} onChange={(e) => setName(e.currentTarget.value)} />
      </div>

      <fieldset className="field create-rooms">
        <legend className="field-label">Комнаты</legend>
        <p className="hint">В каждой комнате свой голосовой звонок и свой чат. Потом их можно менять в настройках сервера.</p>
        <ol className="create-room-list">
          {rooms.map((room, i) => (
            <li key={i}>
              <input
                className="input"
                value={room}
                maxLength={MAX_ROOM_NAME}
                aria-label={`Комната ${i + 1}`}
                onChange={(e) => setRooms(rooms.map((r, k) => (k === i ? e.currentTarget.value : r)))}
              />
              <IconButton label="Выше" disabled={i === 0} onClick={() => moveRoom(i, -1)}>
                <ArrowUp size={15} />
              </IconButton>
              <IconButton label="Ниже" disabled={i === rooms.length - 1} onClick={() => moveRoom(i, 1)}>
                <ArrowDown size={15} />
              </IconButton>
              <IconButton label={`Убрать комнату «${room}»`} disabled={rooms.length <= 1} onClick={() => setRooms(rooms.filter((_, k) => k !== i))}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ol>
        <div className="create-room-add">
          <input
            className="input"
            placeholder="Новая комната, например «Игры»"
            value={newRoom}
            maxLength={MAX_ROOM_NAME}
            aria-label="Название новой комнаты"
            onChange={(e) => setNewRoom(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRoom();
              }
            }}
          />
          <Button disabled={!newRoom.trim() || rooms.length >= MAX_ROOMS} onClick={addRoom}>
            <Plus size={15} /> Добавить
          </Button>
        </div>
      </fieldset>

      <p className="create-ways">
        Друзья смогут зайти и с белым IP, и без него — ХатаВойс сам выберет путь. Если захочешь что-то поменять: «Настройки сервера» → «Подключение».
      </p>
      {portsShown && (
        <div className="create-ports">
          <p className="hint">Обычные порты заняты другой программой — укажи другие:</p>
          {PORT_FIELDS.map(({ key, label }) => (
            <label key={key} className="field">
              <span className="field-label">{label}</span>
              <input className="input" type="number" min={1024} max={65535} value={ports[key]} onChange={(e) => setPorts({ ...ports, [key]: Number(e.currentTarget.value) })} />
            </label>
          ))}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Запускаю сервер…" : "Создать сервер"}
        </Button>
      </div>
    </form>
  );
}

export function AddServerModal({ open, onClose, initialTab = "connect", initialLink = null }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Modal open={open} onClose={onClose} title="Добавить сервер">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "connect"} className="tab" onClick={() => setTab("connect")}>
          Подключиться
        </button>
        {CAN_HOST && (
          <button type="button" role="tab" aria-selected={tab === "create"} className="tab" onClick={() => setTab("create")}>
            Создать свой
          </button>
        )}
      </div>
      {tab === "connect" ? (
        <ConnectTab key={initialLink ?? ""} onDone={onClose} initialLink={initialLink} />
      ) : (
        <CreateTab onDone={onClose} />
      )}
    </Modal>
  );
}

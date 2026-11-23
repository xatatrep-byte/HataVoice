import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_MAC, shortcut } from "../../platform";
import {
  ChevronDown,
  Copy,
  Headphones,
  LogOut,
  MessagesSquare,
  Mic,
  Minus,
  Plus,
  Radio,
  Search,
  Settings,
  Settings2,
  Square,
  Trash2,
  UserPlus,
  UserRoundPen,
  Users,
  X,
} from "lucide-react";
import type { SavedServer } from "../../state/servers";
import { usePrefs, type ProfileColor } from "../../state/prefs";
import { IconButton } from "../../ui/IconButton";
import { Avatar, initials } from "../../ui/Avatar";
import { notify } from "../../ui/toasts";
import "./shell.css";

/** The mark of the program: a little house in a rounded square of the accent. */
export function HouseMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="house-mark" viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <rect width="28" height="28" rx="8.5" fill="var(--accent)" />
      <path d="M8 20.5v-7.2L14 8.6l6 4.7v7.2h-4v-4.3h-4v4.3H8Z" fill="var(--on-accent)" />
    </svg>
  );
}

/** A server as a small square with its initials. */
export function ServerMark({ name, color }: { name: string; color: string }) {
  return (
    <span className="server-mark" style={{ background: `var(--av-${color})` }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/**
 * Our own buttons of the window, since it has no system title bar. Linux runs in a browser window that has its own; a
 * Mac shows its own three buttons over the left of our bar (tauri.macos.conf.json).
 */
const OWN_WINDOW_FRAME = /windows/i.test(typeof navigator === "undefined" ? "" : navigator.userAgent) && !IS_MAC;

function WindowControls() {
  if (!isTauri() || !OWN_WINDOW_FRAME) return null;
  const window = () => getCurrentWindow();
  return (
    <span className="window-controls">
      <button type="button" aria-label="Свернуть" onClick={() => void window().minimize()}>
        <Minus size={16} />
      </button>
      <button type="button" aria-label="Развернуть" onClick={() => void window().toggleMaximize()}>
        <Square size={13} />
      </button>
      <button type="button" className="close" aria-label="Закрыть" onClick={() => void window().close()}>
        <X size={17} />
      </button>
    </span>
  );
}

/** Closes what is open on a click elsewhere or Escape. */
export function useClosing<T extends HTMLElement = HTMLDivElement>(open: boolean, close: () => void) {
  const box = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return box;
}

/** A row of a menu: an icon, words, and what it holds on the right. */
function Item({ icon, children, onClick, danger, end }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; end?: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={danger ? "menu-item danger" : "menu-item"} onClick={onClick}>
      {icon}
      <span className="menu-item-text">{children}</span>
      {end}
    </button>
  );
}

type HouseMenuProps = {
  server: { name: string; address: string; color?: string } | null;
  servers: SavedServer[];
  serversUnread: Record<string, { messages: number; mentions: number }>;
  onSelect: (address: string) => void;
  onAdd: () => void;
  /** Copies an invite; only for those who may make one. */
  onInvite?: () => void;
  /** Opens the people of the house. */
  onPeople?: () => void;
  /** Opens the house's settings. */
  onSettings?: () => void;
  /** Leaves the server for good; offered to everyone but its owner. */
  onLeave?: () => Promise<void>;
  /** Asks to delete the server; its owner's, on the PC it runs on. */
  onDelete?: () => void;
  /** Takes the server off this PC's list; its owner's, when it runs elsewhere. */
  onForget?: () => void;
};

/** The chevron next to the house's name: the other houses and what can be done with this one. */
export function HouseMenu({ server, servers, serversUnread, onSelect, onAdd, onInvite, onPeople, onSettings, onLeave, onDelete, onForget }: HouseMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const box = useClosing(open || confirming, () => {
    setOpen(false);
    setConfirming(false);
  });
  const newsElsewhere = Object.entries(serversUnread).some(([address, news]) => address !== server?.address && (news.messages > 0 || news.mentions > 0));
  const run = (what: () => void) => () => {
    setOpen(false);
    what();
  };

  async function copyAddress() {
    if (!server) return;
    try {
      await navigator.clipboard.writeText(server.address);
      notify.info("Адрес скопирован");
    } catch {
      notify.error("Не получилось скопировать адрес");
    }
  }

  return (
    <div className="house-menu" ref={box}>
      <button type="button" className="house-chevron" aria-label="Меню сервера" title="Мои серверы и настройки сервера" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={16} aria-hidden />
        {newsElsewhere && <span className="server-news" title="На других серверах есть новое" />}
      </button>
      {open && (
        <div className="menu-panel house-panel" role="menu" aria-label="Меню сервера">
          <p className="menu-label">Мои серверы</p>
          {servers.map((s) => {
            const news = s.address === server?.address ? undefined : serversUnread[s.address];
            return (
              <button
                key={s.address}
                type="button"
                role="menuitem"
                className="house-item"
                aria-current={s.address === server?.address ? "true" : undefined}
                onClick={run(() => onSelect(s.address))}
              >
                <ServerMark name={s.name} color={s.color} />
                <span className="menu-item-text">{s.name}</span>
                {news && news.mentions > 0 ? (
                  <span className="panel-menu-count" aria-label={`Упоминаний: ${news.mentions}`}>
                    @{news.mentions > 99 ? "99+" : news.mentions}
                  </span>
                ) : news && news.messages > 0 ? (
                  <span className="server-news" aria-label="Есть непрочитанное" />
                ) : null}
              </button>
            );
          })}
          <Item icon={<Plus size={17} />} onClick={run(onAdd)}>
            Добавить сервер
          </Item>
          {server && (
            <>
              <div className="menu-sep" role="separator" />
              {onInvite && (
                <Item icon={<UserPlus size={17} />} onClick={run(onInvite)}>
                  Позвать друга
                </Item>
              )}
              {onPeople && (
                <Item icon={<Users size={17} />} onClick={run(onPeople)}>
                  Участники сервера
                </Item>
              )}
              {onSettings && (
                <Item icon={<Settings2 size={17} />} onClick={run(onSettings)}>
                  Настройки сервера
                </Item>
              )}
              <Item icon={<Copy size={17} />} onClick={run(() => void copyAddress())}>
                Скопировать адрес
              </Item>
              {onLeave && (
                <Item icon={<LogOut size={17} />} danger onClick={run(() => setConfirming(true))}>
                  Покинуть сервер
                </Item>
              )}
              {onForget && (
                <Item icon={<X size={17} />} onClick={run(onForget)}>
                  Убрать из списка
                </Item>
              )}
              {onDelete && (
                <Item icon={<Trash2 size={17} />} danger onClick={run(onDelete)}>
                  Удалить сервер
                </Item>
              )}
            </>
          )}
        </div>
      )}
      {confirming && server && (
        <div className="menu-panel house-panel" role="alertdialog" aria-label="Покинуть сервер">
          <p className="menu-confirm">{`Покинуть «${server.name}»? Вернуться можно только по новому приглашению.`}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirming(false);
                onLeave?.().catch((e: unknown) => notify.error(String(e)));
              }}
            >
              Покинуть
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type MeMenuProps = {
  nickname: string;
  color: ProfileColor;
  /** The face of our 3D character. */
  picture?: string | null;
  transmitting: boolean;
  micOn: boolean;
  deafened: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onProfile: () => void;
  onCharacter: () => void;
  /** Recording and streaming; not on a phone. */
  onStudio?: () => void;
  onSettings: () => void;
};

/** Our face, top right: who we are, the mic and the sound, and the things that are ours. */
export function MeMenu(props: MeMenuProps) {
  const frame = usePrefs((s) => s.frame);
  const [open, setOpen] = useState(false);
  const box = useClosing(open, () => setOpen(false));
  const run = (what: () => void) => () => {
    setOpen(false);
    what();
  };
  const { nickname, color, picture } = props;
  return (
    <div className="me-menu" ref={box}>
      <button type="button" className="me-face" aria-label="Мой профиль" title={nickname || "Мой профиль"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar name={nickname} color={color} size={30} speaking={props.transmitting} frame={frame} picture={picture} />
      </button>
      {open && (
        <div className="menu-panel me-panel" role="menu" aria-label="Мой профиль">
          <button type="button" role="menuitem" className="me-head" onClick={run(props.onProfile)}>
            <Avatar name={nickname} color={color} size={42} frame={frame} picture={picture} />
            <span className="menu-item-text">
              <b>{nickname || "Без ника"}</b>
              <small>Профиль и ник</small>
            </span>
          </button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitemcheckbox" aria-checked={props.micOn} className="menu-item" onClick={props.onToggleMic}>
            <Mic size={17} />
            <span className="menu-item-text">Микрофон</span>
            <span className="menu-switch" aria-hidden />
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={!props.deafened} className="menu-item" onClick={props.onToggleDeafen}>
            <Headphones size={17} />
            <span className="menu-item-text">Звук</span>
            <span className="menu-switch" aria-hidden />
          </button>
          <div className="menu-sep" role="separator" />
          <Item icon={<UserRoundPen size={17} />} onClick={run(props.onCharacter)}>
            Мой персонаж
          </Item>
          {props.onStudio && (
            <Item icon={<Radio size={17} />} onClick={run(props.onStudio)}>
              Запись и стрим
            </Item>
          )}
          <Item icon={<Settings size={17} />} onClick={run(props.onSettings)} end={<kbd className="menu-kbd">{shortcut(",")}</kbd>}>
            Настройки
          </Item>
        </div>
      )}
    </div>
  );
}

type Props = {
  /** The house's name; the program's when there is none. */
  house: string;
  /** The mark and the name lead home. */
  onHome: () => void;
  /** The chevron with the houses (a `HouseMenu`). */
  menu?: ReactNode;
  /** «Чаты»: opens the panel; absent with no house. */
  chats?: { unread: number; mentions: number; open: boolean; onToggle: () => void };
  /** Recording or streaming goes on: a red word that leads to it. */
  live?: { label: string; onOpen: () => void } | null;
  /** Something to say on the right: there is a new version. */
  notice?: ReactNode;
  onSearch: () => void;
  /** Our face with its menu (a `MeMenu`). */
  me: ReactNode;
};

/** The top of the window: the house, its chats, search and us; it is also what the window is dragged by. */
export function TopBar({ house, onHome, menu, chats, live, notice, onSearch, me }: Props) {
  const count = chats ? (chats.mentions > 0 ? `@${chats.mentions > 99 ? "99+" : chats.mentions}` : chats.unread > 0 ? (chats.unread > 99 ? "99+" : String(chats.unread)) : null) : null;
  return (
    <header className={IS_MAC && isTauri() ? "top-bar mac" : "top-bar"} data-tauri-drag-region>
      <button type="button" className="top-home" aria-label="На главную" title="На главную" onClick={onHome}>
        <HouseMark />
        <span className="top-house" title={house}>
          {house}
        </span>
      </button>
      {menu}
      {chats && (
        <>
          <span className="top-sep" aria-hidden />
          <button
            type="button"
            className={chats.open ? "top-chats open" : "top-chats"}
            aria-label={count ? `Чаты, новых: ${count}` : "Чаты"}
            aria-expanded={chats.open}
            title="Чаты и люди"
            onClick={chats.onToggle}
          >
            <MessagesSquare size={17} aria-hidden />
            <span className="top-chats-word">Чаты</span>
            {count && <span className={chats.mentions > 0 ? "top-count mention" : "top-count"}>{count}</span>}
          </button>
        </>
      )}
      {live && (
        <button type="button" className="top-live" onClick={live.onOpen}>
          <span className="top-live-lamp" aria-hidden />
          {live.label}
        </button>
      )}
      <span className="top-space" data-tauri-drag-region />
      {notice}
      <IconButton label={`Поиск (${shortcut("K")})`} className="top-search" onClick={onSearch}>
        <Search size={18} />
      </IconButton>
      {me}
      <WindowControls />
    </header>
  );
}

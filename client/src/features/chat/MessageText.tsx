import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isInviteLink } from "../../server/session";
import { openInvite } from "../join/inviteRequest";

// The text of a message as text: a few marks of markdown, links that open in the browser, never HTML. Everything
// is put on the page as text nodes, so nothing a member writes can run.

const BLOCK = /```\n?([\s\S]*?)```/g;
const INLINE = /(<@[a-z0-9]{1,64}>)|(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|((?:https?|hatavoice):\/\/[^\s<>"']+)/g;
/** A mention as it goes in a message: `<@user_id>`. */
const MENTION = /<@([a-z0-9]{1,64})>/g;

/** Who a text names: nicknames by user id, and our own id. */
export type Names = { names: Map<string, string>; me: string };

/** `<@id>` → `@Ник` in a text shown plain (a quote, a notification). */
export function plainMentions(text: string, names: Map<string, string>): string {
  return text.replace(MENTION, (_, id: string) => `@${names.get(id) ?? "кто-то"}`);
}
/** Punctuation that ends a sentence rather than the link before it. */
const TRAILING = /[.,;:!?)\]]+$/;

function Link({ url }: { url: string }) {
  return (
    <a
      href={url}
      className="msg-link"
      title={url}
      onClick={(e) => {
        e.preventDefault();
        if (isInviteLink(url)) openInvite(url);
        else void openUrl(url).catch(() => {});
      }}
    >
      {url}
    </a>
  );
}

function inline(text: string, key: string, who: Names): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, mention, code, bold, italic, link] = match;
    let start = match.index;
    let end = start + whole.length;
    if (start > last) nodes.push(text.slice(last, start));
    const id = `${key}-${n++}`;
    if (mention) {
      const user = mention.slice(2, -1);
      nodes.push(
        <span key={id} className={user === who.me ? "mention me" : "mention"}>
          @{who.names.get(user) ?? "кто-то"}
        </span>,
      );
    } else if (code) nodes.push(<code key={id}>{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={id}>{bold.slice(2, -2)}</strong>);
    else if (italic) nodes.push(<em key={id}>{italic.slice(1, -1)}</em>);
    else if (link) {
      const url = link.replace(TRAILING, "");
      end = start + url.length;
      nodes.push(<Link key={id} url={url} />);
    }
    last = end;
    start = end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** `after` goes on the text's last line (the «(изменено)» mark); mentions are shown by nickname from `names`. */
export function MessageText({ text, after, names, me }: { text: string; after?: ReactNode; names?: Map<string, string>; me?: string }) {
  const who: Names = { names: names ?? new Map(), me: me ?? "" };
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(BLOCK)) {
    if (match.index > last) nodes.push(...inline(text.slice(last, match.index), `t${n}`, who));
    nodes.push(
      <pre key={`b${n}`} className="msg-code">
        <code>{match[1]}</code>
      </pre>,
    );
    last = match.index + match[0].length;
    n++;
  }
  if (last < text.length) nodes.push(...inline(text.slice(last), `t${n}`, who));
  return (
    <div className="msg-text">
      {nodes}
      {after}
    </div>
  );
}

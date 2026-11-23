import { BarChart3, Check } from "lucide-react";
import type { ItemView } from "../../chat/api";
import type { MemberView } from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { nameOf } from "./MessageList";

type Props = {
  item: ItemView;
  me: string;
  members: Map<string, MemberView>;
  /** Our whole choice; empty takes the vote back. */
  onVote: (choice: number[]) => void;
  onClose: () => void;
};

/** «1 голос», «3 голоса», «5 голосов». */
export function votesLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} голос`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} голоса`;
  return `${count} голосов`;
}

/** A poll in the feed: its options with how many chose each and who, our choice, and its end. */
export function PollCard({ item, me, members, onVote, onClose }: Props) {
  const poll = item.poll;
  if (!poll) return null;
  const voters = new Set(poll.options.flatMap((o) => o.voters));
  const mine = poll.options.flatMap((o, index) => (o.voters.includes(me) ? [index] : []));
  const choose = (index: number) => {
    if (poll.multi) onVote(mine.includes(index) ? mine.filter((i) => i !== index) : [...mine, index].sort((a, b) => a - b));
    else onVote(mine.includes(index) ? [] : [index]);
  };
  return (
    <div className={poll.closed ? "poll closed" : "poll"}>
      <div className="poll-question">
        <BarChart3 size={16} aria-hidden /> {poll.question}
      </div>
      <p className="poll-note">
        {poll.closed ? "Голосование завершено" : poll.multi ? "Можно выбрать несколько" : "Один вариант"} · Голоса видны всем
      </p>
      <ul className="poll-options">
        {poll.options.map((option, index) => {
          const share = voters.size === 0 ? 0 : Math.round((option.voters.length / voters.size) * 100);
          const chosen = option.voters.includes(me);
          return (
            <li key={index}>
              <button
                type="button"
                className={chosen ? "poll-option chosen" : "poll-option"}
                aria-pressed={chosen}
                disabled={poll.closed}
                onClick={() => choose(index)}
              >
                <span className="poll-bar" style={{ width: `${share}%` }} aria-hidden />
                <span className="poll-option-text">
                  {chosen && <Check size={14} aria-hidden />} {option.text}
                </span>
                <span className="poll-share">
                  {share}% · {votesLabel(option.voters.length)}
                </span>
              </button>
              {option.voters.length > 0 && (
                <span className="poll-voters" aria-label={`Выбрали «${option.text}»`}>
                  {option.voters.map((user) => (
                    <span key={user} title={nameOf(members, user)}>
                      <Avatar name={nameOf(members, user)} color={members.get(user)?.color ?? "blue"} size={18} />
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!poll.closed && item.author === me && (
        <Button className="poll-close" onClick={onClose}>
          Завершить
        </Button>
      )}
    </div>
  );
}

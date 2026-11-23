// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { withMemberNames, toParticipantViews } from "../voice/participants";
import { member } from "../server/testState";
import { Avatar, avatarFill } from "./Avatar";

afterEach(cleanup);

describe("avatars", () => {
  it("wear a known frame, and nothing for a frame this app does not know", () => {
    const { container } = render(<Avatar name="Петя" color="#ff8a4c" size={40} frame="neon" />);
    const framed = container.querySelector(".framed.frame-neon") as HTMLElement;
    expect(framed.style.getPropertyValue("--s")).toBe("40px");
    expect((container.querySelector(".avatar") as HTMLElement).style.background).toBe("rgb(255, 138, 76)");
    cleanup();
    const plain = render(<Avatar name="Петя" color="pink" frame="dragon" />);
    expect(plain.container.querySelector(".framed")).toBeNull();
    expect(avatarFill("pink")).toBe("var(--av-pink, var(--av-blue))");
  });

  it("the stage takes the frame and an own color from the group", () => {
    const views = toParticipantViews([{ identity: "a", name: "", isSpeaking: false, isMicrophoneEnabled: true, isLocal: false }]);
    const [view] = withMemberNames(views, [member("a", "Аня", { color: "#00ff88", frame: "crown" })]);
    expect(view).toMatchObject({ name: "Аня", color: "#00ff88", frame: "crown" });
  });
});

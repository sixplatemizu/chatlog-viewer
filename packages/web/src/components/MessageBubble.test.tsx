import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
  it("超长消息默认折叠，展开后才渲染全文", () => {
    const content = Array.from({ length: 260 }, (_, index) => `line-${index + 1}`).join("\n");

    render(
      <MessageBubble
        dark={false}
        message={{
          role: "assistant",
          content,
          timestamp: 1,
        }}
      />
    );

    expect(screen.getByRole("button", { name: "展开全文" })).toBeInTheDocument();
    expect(screen.queryByText("line-200")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));

    expect(screen.getByRole("button", { name: "折叠长消息" })).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName.toLowerCase() === "p" && !!element.textContent?.includes("line-200")
    )).toBeInTheDocument();
  });
});

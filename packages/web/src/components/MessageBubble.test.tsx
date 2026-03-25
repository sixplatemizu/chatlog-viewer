import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("可编辑消息会显示编辑操作并触发保存回调", async () => {
    const handleUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <MessageBubble
        dark={false}
        message={{
          messageId: "text:1",
          role: "assistant",
          content: "old content",
          timestamp: 1,
          editable: true,
        }}
        onUpdateMessage={handleUpdate}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new content" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(handleUpdate).toHaveBeenCalledWith("text:1", "new content");
  });
});

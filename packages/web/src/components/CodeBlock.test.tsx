import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("超大代码块默认折叠，并在展开后回退为纯文本渲染", () => {
    const hugeCode = Array.from({ length: 1300 }, (_, index) => `line-${index + 1}`).join("\n");

    render(
      <CodeBlock
        code={hugeCode}
        dark={false}
        language="typescript"
      />
    );

    expect(screen.getByRole("button", { name: "展开代码" })).toBeInTheDocument();
    expect(screen.queryByText("line-1200")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开代码" }));

    expect(screen.getByText("超大代码块已切换为纯文本渲染，避免高亮导致界面卡顿。")).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName.toLowerCase() === "code" && !!element.textContent?.includes("line-1200")
    )).toBeInTheDocument();
  });
});

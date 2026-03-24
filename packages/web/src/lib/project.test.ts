import { describe, expect, it } from "vitest";
import {
  canonicalizeProjectPath,
  getDisambiguatedProjectName,
  getProjectName,
  getProjectPathHint,
  isSameProjectPath,
} from "./project";

describe("project path formatting", () => {
  it("home 目录显示为 ~", () => {
    expect(getProjectName("C:/Users/mortis097", "-C-Users-mortis097")).toBe("~");
    expect(getProjectPathHint("C:/Users/mortis097", "-C-Users-mortis097")).toBe("~");
  });

  it("用户目录下的项目显示为带 ~ 前缀的完整目录", () => {
    expect(
      getDisambiguatedProjectName(
        "C:/Users/mortis097/Desktop/code_area/chatlog-viewer",
        "-C-Users-mortis097-Desktop-code_area-chatlog-viewer",
        []
      )
    ).toBe("~/desktop/code_area/chatlog-viewer");

    expect(
      getProjectPathHint(
        "C:/Users/mortis097/Desktop/code_area/chatlog-viewer",
        "-C-Users-mortis097-Desktop-code_area-chatlog-viewer"
      )
    ).toBe("~/desktop/code_area/chatlog-viewer");
  });

  it("同名项目冲突时保持完整可读路径，不再截断消歧", () => {
    expect(
      getDisambiguatedProjectName(
        "C:/Users/mortis097/Desktop/code_area/chatlog-viewer",
        "-C-Users-mortis097-Desktop-code_area-chatlog-viewer",
        [
          {
            project: "D:/workspace/code_area/chatlog-viewer",
            projectKey: "D:/workspace/code_area/chatlog-viewer",
          },
        ]
      )
    ).toBe("~/desktop/code_area/chatlog-viewer");
  });

  it("不可读的内部 projectKey 不参与前端路径拆分", () => {
    expect(
      getDisambiguatedProjectName(
        "C:/Users/mortis097/Desktop/code_area/chatlog-viewer",
        "-C-Users-mortis097-Desktop-code_area-chatlog-viewer",
        [
          {
            project: "C:/Users/mortis097",
            projectKey: "-C-Users-mortis097-Desktop-code_area-chatlog-viewer",
          },
        ]
      )
    ).toBe("~/desktop/code_area/chatlog-viewer");
  });

  it("Windows 路径分组 key 按大小写不敏感归一", () => {
    expect(
      canonicalizeProjectPath("C:/Users/mortis097/Desktop/code_area/r-bioinfo")
    ).toBe("c:/users/mortis097/desktop/code_area/r-bioinfo");
    expect(
      canonicalizeProjectPath("C:/Users/mortis097/desktop/code_area/r-bioinfo")
    ).toBe("c:/users/mortis097/desktop/code_area/r-bioinfo");
    expect(
      isSameProjectPath(
        "C:/Users/mortis097/Desktop/code_area/r-bioinfo",
        "C:/Users/mortis097/desktop/code_area/r-bioinfo"
      )
    ).toBe(true);
  });
});

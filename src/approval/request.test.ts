import { describe, expect, it } from "vitest";
import { fingerprintApprovalAction } from "./request";

describe("fingerprintApprovalAction", () => {
  it("normalizes command newlines and unicode", () => {
    const lf = fingerprintApprovalAction({
      kind: "tool_call",
      toolName: "bash",
      command: "echo café\n",
    });
    const crlfDecomposed = fingerprintApprovalAction({
      kind: "tool_call",
      toolName: "bash",
      command: "echo cafe\u0301\r\n",
    });

    expect(crlfDecomposed).toBe(lf);
  });

  it("normalizes path separators for path access fingerprints", () => {
    const slash = fingerprintApprovalAction({
      kind: "path_access",
      toolName: "read",
      path: "/tmp/demo/file.txt",
    });
    const backslash = fingerprintApprovalAction({
      kind: "path_access",
      toolName: "read",
      path: "\\tmp\\demo\\file.txt",
    });

    expect(backslash).toBe(slash);
  });
});

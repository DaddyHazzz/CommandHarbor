import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./version";

describe("workspace", () => {
  it("exports a protocol version", () => expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/));
});

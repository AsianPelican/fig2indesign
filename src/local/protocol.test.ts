import {expect, test} from "bun:test";
import {LOCAL_HOST, parseFigmaJob} from "./protocol";

test("localhost protocol accepts synthetic selections and rejects font embedding", () => {
  expect(LOCAL_HOST).toBe("127.0.0.1");
  expect(parseFigmaJob({kind: "figma", fileKey: "SyntheticFile0001", frameIds: ["1:2"], frameNames: ["Synthetic frame"]}).frameIds).toEqual(["1:2"]);
  expect(() => parseFigmaJob({kind: "figma", fileKey: "SyntheticFile0001", frameIds: ["1:2"], frameNames: ["Synthetic frame"], embedFonts: true})).toThrow("font embedding");
});

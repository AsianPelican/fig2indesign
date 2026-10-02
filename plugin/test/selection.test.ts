import {describe, expect, test} from "bun:test";
import {selectionRequest} from "../src/selection";

describe("Figma selection", () => {
  test("exports selected top-level frames in selection order", () => {
    const request = selectionRequest("SyntheticDeck0001", [
      {id: "1:2", name: "One", type: "FRAME", parent: {type: "PAGE"}},
      {id: "1:3", name: "Nested", type: "FRAME", parent: {type: "FRAME"}},
      {id: "1:4", name: "Two", type: "FRAME", parent: {type: "SECTION"}},
      {id: "1:5", name: "Group", type: "GROUP", parent: {type: "PAGE"}},
    ]);
    expect(request).toEqual({fileKey: "SyntheticDeck0001", frameIds: ["1:2", "1:4"], frameNames: ["One", "Two"]});
  });
});

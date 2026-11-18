// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vitest"

// Counts name only what there is (visual review A V-13, V-23: "Plus 0 parts (DialogTitle, MenuItem)").

let partsAndIcons: (c: { parts?: number; icons?: number }) => string
beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ title: "Sample", label: "Sample" })
  document.head.append(data)
  ;({ partsAndIcons } = await import("@/lib/dsa"))
})

test("names only the counts above zero, with plurals", () => {
  expect(partsAndIcons({ parts: 0, icons: 0 })).toBe("")
  expect(partsAndIcons({ parts: 1, icons: 0 })).toBe("1 part")
  expect(partsAndIcons({ parts: 0, icons: 12 })).toBe("12 icons")
  expect(partsAndIcons({ parts: 3, icons: 1 })).toBe("3 parts and 1 icon")
})

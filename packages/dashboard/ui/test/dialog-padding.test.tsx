import { expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

// A dialog's footer bleeds to its edges by the dialog's own padding (--dialog-pad). Padding set with
// p-* on DialogContent leaves the footer short of the edge, so dialogs change the variable instead.

const src = path.resolve(import.meta.dirname, "../src")
const read = (f: string) => fs.readFileSync(path.join(src, f), "utf8")

test("DialogContent and DialogFooter share one padding variable", () => {
  const ui = read("components/ui/dialog.tsx")
  expect(ui).toContain("p-(--dialog-pad) [--dialog-pad:--spacing(4)]")
  expect(ui).toContain("-mx-(--dialog-pad) -mb-(--dialog-pad)")
  expect(ui).not.toMatch(/-mx-4 -mb-4/)
})

test("no dialog sets its padding with p-*", () => {
  const files = fs.readdirSync(src, { recursive: true }).map(String).filter(f => f.endsWith(".tsx") && !f.startsWith(`components${path.sep}ui`))
  const bad: string[] = []
  for (const f of files) {
    for (const m of read(f).matchAll(/<DialogContent\b[^>]*?className="([^"]*)"/g)) {
      const cls = m[1]!.split(/\s+/).filter(c => /^(sm:|md:|lg:)?p[xytrbl]?-\d/.test(c))
      if (cls.length) bad.push(`${f}: ${cls.join(" ")}`)
    }
  }
  expect(bad).toEqual([])
})

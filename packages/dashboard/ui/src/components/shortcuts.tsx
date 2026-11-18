import * as React from "react"
import { KeyboardIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { KEYS, typingIn } from "@/views/elements/keys"
import { D } from "@/lib/dsa"

/**
 * Every keyboard shortcut in one place, from a button in the header or the ? key (design review: the
 * keys were listed inline in the content area). Grouped by where they work.
 */
const GROUPS: { title: string; when: string; keys: [string[], string][] }[] = [
  { title: "Anywhere", when: "When you're not typing", keys: [[["?"], "Show these shortcuts"], [["D"], "Switch light and dark"]] },
  { title: "Inbox", when: "The issue list", keys: [[["J"], "Next issue"], [["K"], "Previous issue"], [["Shift", "J"], "Next issue, while an issue's places are open"], [["Shift", "K"], "Previous issue, while an issue's places are open"], [["X"], "Tick the open issue"], [["Esc"], "Clear the ticks"]] },
  { title: "Reviewing places", when: "Element Review, and an issue's places", keys: KEYS.map(k => [k.keys, k.says.charAt(0).toUpperCase() + k.says.slice(1)] as [string[], string]) },
  { title: "Photo viewer", when: "A photo opened large", keys: [[["←"], "Previous photo"], [["→"], "Next photo"], [["+"], "Zoom in"], [["−"], "Zoom out"]] },
  { title: "Agent", when: "The message box", keys: [[["Enter"], "Send"], [["Shift", "Enter"], "New line"], [["Esc"], "Close the side panel when it covers the page"]] },
]

export function Shortcuts() {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target) || document.querySelector('[role="dialog"]')) return
      e.preventDefault(); setOpen(true)
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, [])
  const groups = GROUPS.filter(g => g.title !== "Agent" || D.serve)
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" size="icon" aria-label="Keyboard shortcuts" onClick={() => setOpen(true)} />}><KeyboardIcon /></TooltipTrigger>
        <TooltipContent>Keyboard shortcuts <Kbd>?</Kbd></TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Shortcuts never fire while you type in a field, or with Ctrl, Cmd or Alt held.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 sm:grid-cols-2">
            {groups.map(g => (
              <section key={g.title} aria-labelledby={`keys-${g.title}`} className="flex flex-col gap-2">
                <div>
                  <h3 id={`keys-${g.title}`} className="text-sm font-semibold">{g.title}</h3>
                  <p className="text-xs text-muted-foreground">{g.when}</p>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
                  {g.keys.map(([ks, says]) => (
                    <React.Fragment key={says}>
                      <dt className="flex items-center gap-1">{ks.map((k, i) => <React.Fragment key={k}>{i > 0 && <span className="text-xs text-muted-foreground">+</span>}<Kbd>{k}</Kbd></React.Fragment>)}</dt>
                      <dd>{says}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

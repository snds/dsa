import * as React from "react"

/**
 * The control size for a row: every Button, split button, field, select and toggle inside takes it
 * unless it names its own, so a row of actions or a field with its button lines up (same height, font,
 * icon, radius and padding). Sizes map to the --spacing-control* tokens in index.css.
 */
export type ControlSizeName = "sm" | "default" | "lg"
const Ctx = React.createContext<ControlSizeName>("default")

export function ControlSize({ size, children }: { size: ControlSizeName; children: React.ReactNode }) {
  return <Ctx.Provider value={size}>{children}</Ctx.Provider>
}
export const useControlSize = () => React.useContext(Ctx)
/** The square icon-button size that matches a control size. */
export const iconSizeFor = (s: ControlSizeName | "xs") => (s === "xs" ? "icon-xs" : s === "sm" ? "icon-sm" : s === "lg" ? "icon-lg" : "icon") as "icon-xs" | "icon-sm" | "icon" | "icon-lg"

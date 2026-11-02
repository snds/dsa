import type * as React from "react"
import { InfoIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { APPS, setApp, useApp } from "@/lib/app"

/**
 * The page's app, in the header beside "Ask the agent": all apps, or one, and every view shows that
 * app's numbers. Hidden when the scan measured one app (there's nothing to choose).
 */
export function AppSelect({ className }: { className?: string }) {
  const app = useApp()
  if (APPS.length < 2) return null
  return (
    <label className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span className="text-sm text-muted-foreground">App</span>
      <NativeSelect aria-label="App" value={app ?? ""} onChange={e => setApp(e.target.value || null)} className="min-w-0 max-w-[14rem]">
        <NativeSelectOption value="">All apps</NativeSelectOption>
        {APPS.map(a => <NativeSelectOption key={a} value={a}>{a}</NativeSelectOption>)}
      </NativeSelect>
    </label>
  )
}

/**
 * Said where a number covers every app though one app is chosen: the report doesn't split it, and it
 * must never pass for that app's number. Nothing shows on all apps.
 */
export function AllAppsNote({ children, className }: { children?: React.ReactNode; className?: string }) {
  const app = useApp()
  if (!app) return null
  return (
    <p role="note" data-slot="all-apps-note" className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}>
      <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children ?? "Across all apps; this measure isn't split by app yet."}</span>
    </p>
  )
}

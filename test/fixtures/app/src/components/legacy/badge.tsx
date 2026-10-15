import * as React from "react";

// Same name as the DS Badge, but it lives outside the DS source: an exact look-alike.
export function Badge(props: any) {
  return <span className="legacy-badge" {...props} />;
}

import * as React from "react";
import { Button } from "@/components/ui/button";

// A local wrapper whose name near-matches the DS Button: a look-alike.
export function PrimaryButton(props: any) {
  return <Button variant="primary" size="md" {...props} />;
}

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Search } from "@/components/ui/search";
import { Toolbar } from "@/components/ui/toolbar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/legacy/badge";

export function Contacts({ filters, groups }: any) {
  return (
    <main>
      {/* FilterBar-like composition, occurrence 3 (second host) */}
      <div className="flex">
        <Search placeholder="Find a person" />
        {filters.map((f: any) => (
          <Chip key={f.id} variant="removable">
            {f.label}
          </Chip>
        ))}
        <Toolbar>
          <Button variant="ghost" size="sm">
            Clear
          </Button>
        </Toolbar>
      </div>

      {/* Standalone two-button toolbar: a compound-component case, occurrence 1 */}
      <Toolbar>
        <Button variant="outline">Import</Button>
        <Button variant="outline">Export</Button>
      </Toolbar>

      {/* Card-as-stat-tile: all DS, one family, 5 nodes: a variant case, occurrence 1 */}
      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>Everyone you have written to</CardDescription>
        </CardHeader>
        <CardContent>{groups.length}</CardContent>
      </Card>

      <Badge>legacy</Badge>
    </main>
  );
}

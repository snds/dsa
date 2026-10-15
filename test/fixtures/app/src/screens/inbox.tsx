import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Search } from "@/components/ui/search";
import { Table } from "@/components/ui/table";
import { Toolbar } from "@/components/ui/toolbar";
import { Input } from "@/components/ui/form";

export function Inbox({ filters, field }: any) {
  return (
    <section>
      {/* FilterBar-like composition, occurrence 1 */}
      <div className="flex gap-2">
        <Search placeholder="Search mail" />
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
      <Table />
      <Button className="ml-2" variant="secondary">
        Load more
      </Button>
      <Input {...field} />
    </section>
  );
}

export function Archive({ filters }: any) {
  return (
    <section>
      {/* FilterBar-like composition, occurrence 2 (same file, different screen) */}
      <div className="flex gap-2 opacity-80">
        <Search placeholder="Search archive" />
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
      <Table />
    </section>
  );
}

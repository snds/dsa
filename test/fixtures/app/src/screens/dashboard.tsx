import * as React from "react";
import { Button } from "@/components/ui/button";
import { Toolbar } from "@/components/ui/toolbar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/StatCard";

export function Dashboard({ unread, sent }: any) {
  return (
    <main>
      {/* Standalone two-button toolbar, occurrences 2 and 3 */}
      <Toolbar>
        <Button variant="outline">Refresh</Button>
        <Button variant="outline">Settings</Button>
      </Toolbar>

      <Card>
        <CardHeader>
          <CardTitle>Unread</CardTitle>
          <CardDescription>Messages waiting for you</CardDescription>
        </CardHeader>
        <CardContent>{unread}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sent today</CardTitle>
          <CardDescription>Messages you sent since midnight</CardDescription>
        </CardHeader>
        <CardContent>{sent}</CardContent>
      </Card>

      <StatCard title="Drafts" value={3} />
      <Badge variant="outline">beta</Badge>

      <footer>
        <Toolbar>
          <Button variant="outline">Help</Button>
          <Button variant="outline">Sign out</Button>
        </Toolbar>
      </footer>
    </main>
  );
}

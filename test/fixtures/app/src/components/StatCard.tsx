import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// An already-named local composition; nearestExisting should find it for Card-based candidates.
export function StatCard({ title, value }: any) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Badge variant="outline">{value}</Badge>
      </CardHeader>
      <CardContent>{value}</CardContent>
    </Card>
  );
}

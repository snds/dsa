import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Form, Input, Label } from "@/components/ui/form";

// Dialog used as a form, three times in ONE file: three occurrences but one
// host, so it stays a snowflake until a second screen does the same thing.
export function RenameDialog({ open }: any) {
  return (
    <Dialog open={open}>
      <DialogContent size="sm">
        <DialogTitle>Rename</DialogTitle>
        <Form>
          <Label>Name</Label>
          <Input />
          <Button type="submit">Save</Button>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function SignatureDialog({ open }: any) {
  return (
    <Dialog open={open}>
      <DialogContent size="sm">
        <DialogTitle>Signature</DialogTitle>
        <Form>
          <Label>Signature</Label>
          <Input />
          <Button type="submit">Save</Button>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function ForwardingDialog({ open }: any) {
  return (
    <Dialog open={open}>
      <DialogContent size="sm">
        <DialogTitle>Forwarding</DialogTitle>
        <Form>
          <Label>Address</Label>
          <Input />
          <Button type="submit">Save</Button>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

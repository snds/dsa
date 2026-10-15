import * as React from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { PrimaryButton } from "@/components/PrimaryButton";

// An html-heavy marketing screen with one external component and one local look-alike.
export function Landing() {
  return (
    <section>
      <header>
        <h1>Mail that stays out of your way</h1>
        <p>Fast, calm and yours.</p>
      </header>
      <ul>
        <li>Unified inbox</li>
        <li>Snooze and schedule</li>
        <li>Keyboard first</li>
      </ul>
      <Link to="/pricing">See pricing</Link>
      <PrimaryButton>Get started</PrimaryButton>
      <Button variant="link" style={{ marginTop: 8 }}>
        Learn more
      </Button>
      <footer>
        <small>Made with care.</small>
      </footer>
    </section>
  );
}

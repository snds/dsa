// A profile as a system would keep it in its own repo.
export default {
  name: "acme",
  label: "Acme",
  sources: ["@acme/"],
  components: () => [{ name: "Button", from: "@acme/ui/button", kind: "own" }],
  roles: { button: { use: "Button", from: "@acme/ui/button" } },
  files: { exceptions: "docs/raw-elements.exceptions.json" },
};

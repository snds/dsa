import { canonicalComponent, familyOf } from "../data/index.js";
import { anatomyNodes, type AnatomyNode } from "./anatomy.js";

/** Role words implied by the components a composition contains, most specific first. */
const ROLE_RULES: { role: string; components: string[] }[] = [
  { role: "Confirm", components: ["Alert Dialog"] },
  { role: "Wizard", components: ["Stepper"] },
  { role: "Filter", components: ["Search", "Combobox", "Chip"] },
  { role: "Form", components: ["Form", "Input", "Textarea", "Checkbox", "Radio Group", "Select", "Switch", "Slider", "Date Picker", "Number Input", "File Upload"] },
  { role: "Async", components: ["Skeleton", "Spinner", "Empty State"] },
  { role: "Stat", components: ["Badge", "Meter", "Progress"] },
  { role: "Tabbed", components: ["Tabs"] },
  { role: "Profile", components: ["Avatar"] },
  { role: "Nav", components: ["Navigation Menu", "Breadcrumb", "Link", "Menubar"] },
  { role: "Menu", components: ["Dropdown Menu", "Context Menu"] },
  { role: "Media", components: ["Carousel", "Image"] },
  { role: "List", components: ["List", "Table", "Data Table", "Tree View", "Timeline"] },
  { role: "Action", components: ["Button", "Toggle", "Toggle Group", "Toolbar"] },
  { role: "Alert", components: ["Alert", "Banner", "Toast"] },
];

const BAR_TAGS = new Set(["div", "header", "footer", "nav", "span", "aside", "section", "menu"]);

function pascal(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function roleWord(anatomy: AnatomyNode): string | undefined {
  const rootCanonical = canonicalComponent(anatomy.component);
  const present = new Set<string>();
  for (const n of anatomyNodes(anatomy).slice(1)) {
    if (n.kind === "html") continue;
    const c = canonicalComponent(n.component);
    // Children that are the root's own parts (CardHeader under Card) carry no role.
    if (c && c !== rootCanonical) present.add(c);
  }
  for (const rule of ROLE_RULES) {
    if (rule.components.some((c) => present.has(c))) return rule.role;
  }
  return undefined;
}

/** A shape prop on the root such as `variant="destructive"` names the variant. */
function rootVariantWord(anatomy: AnatomyNode): string | undefined {
  for (const key of ["variant", "intent", "appearance", "tone", "kind", "type", "size"]) {
    const v = anatomy.shapeProps[key];
    if (v && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(v) && v !== "true" && v !== "false" && v !== "default") return pascal(v);
  }
  return undefined;
}

/**
 * Candidate name by intent: a role word from what the children do plus the
 * root (for a design-system root) or a container word (for a wrapper root).
 */
export function suggestName(anatomy: AnatomyNode): string {
  const role = roleWord(anatomy);
  if (anatomy.kind === "ds" || anatomy.kind === "local") {
    const root = pascal(canonicalComponent(anatomy.component) ?? anatomy.component.replace(/\./g, " "));
    if (role) return `${role}${root}`;
    const variant = rootVariantWord(anatomy);
    if (variant) return `${variant}${root}`;
    return `${root}Recipe`;
  }
  const tag = anatomy.component.toLowerCase();
  const componentCount = anatomyNodes(anatomy).filter((n) => n.kind !== "html").length;
  const heavy = anatomyNodes(anatomy).some((n) => {
    const fam = n.kind === "html" ? undefined : familyOf(n.component);
    return fam === "Data Display" && ["List", "Table", "Data Table", "Tree View", "Timeline"].includes(canonicalComponent(n.component) ?? "") || fam === "Layout";
  });
  let suffix = "Section";
  if (tag === "form") suffix = "Form";
  else if (tag === "ul" || tag === "ol") suffix = "List";
  else if (BAR_TAGS.has(tag) && componentCount <= 4 && !heavy) suffix = "Bar";
  else if (BAR_TAGS.has(tag)) suffix = "Panel";
  return `${role ?? "Composite"}${suffix}`;
}

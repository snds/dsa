/**
 * The system model: what a design system is and how code uses it, as a graph of
 * concepts, their realizations and their uses. Every fact carries its evidence.
 *
 *   Kind (universal, name-free)  →  Concept (this system's named decision)
 *     →  Realization (an artifact in one medium)  →  Use (an instance in consumer code)
 *
 * Kinds come later, from archetypes; this module builds concepts, realizations and uses.
 */

/** How reliable a source class is, most reliable first. */
export type Tier =
  | "manifest" //  published metadata: custom-elements.json, web-types, macro options
  | "declaration" // a registration or declaration in source: customElements.define, @Component selector, macro
  | "export" // a public export of a package or an index file
  | "style" // a class block in a stylesheet
  | "convention"; // a naming rule (tag prefix, kebab form of a name)

export interface Evidence {
  /** Root-relative file the fact was read from. */
  file: string;
  line?: number | undefined;
  /** The extractor that produced it. */
  extractor: string;
  tier: Tier;
}

/** Every way a concept can be written in consumer code. */
export type RealizationForm =
  | { form: "import"; symbol: string } // an exported symbol: Button, Dialog, Root (as Dialog)
  | { form: "tag"; tag: string } // an element name: acme-button, x-btn, XBtn, ac-card
  | { form: "selector"; tag?: string | undefined; attribute?: string | undefined } // button[acButton], [acTooltip]
  | { form: "class"; block: string } // a class block: btn, acme-button, ab--btn
  | { form: "macro"; name: string }; // a template macro: acmeButton

export type Realization = RealizationForm & { evidence: Evidence };

export interface Concept {
  /** Normalised identity: lowercase letters and digits, system prefixes removed. */
  key: string;
  /** The system's own name for it, as declared. */
  name: string;
  /**
   * `component` unless the system declares components some other way (macros, exports, tags) and this
   * concept is known only as a CSS class: then it is a `style` object (a grid row, a heading class).
   * In a system made only of classes, every block is a component.
   */
  role: "component" | "style";
  /** The library it belongs to: the system (core) or one of its children. */
  library?: string | undefined;
  realizations: Realization[];
  /** Variant axes: a prop or class family and the closed set of values it picks from. */
  axes?: { name: string; values: string[]; evidence: Evidence }[] | undefined;
  /** Named parts of its anatomy (title, trigger, body), from sub-components, slots, parts and BEM elements. */
  parts?: { name: string; evidence: Evidence }[] | undefined;
  /** Tokens its own styles reference (`var(--x)`, `$x`): the concept-to-token binding. */
  tokens?: { name: string; evidence: Evidence }[] | undefined;
}

/** A named design decision: a CSS custom property, a Sass variable, or a DTCG / Style Dictionary token. */
export interface Token {
  name: string;
  value?: string | undefined;
  /** The token its value refers to, when it's an alias (`var(--x)`, `$x`, `{a.b}`). */
  aliasOf?: string | undefined;
  group: "color" | "typography" | "spacing" | "radius" | "elevation" | "motion" | "breakpoints" | "zIndex" | "other";
  /** From the alias graph: a literal is primitive, an alias semantic; a name carrying a component's is component. */
  tier: "primitive" | "semantic" | "component";
  /** Modes it is set in besides the default (dark, a theme name). */
  modes?: string[] | undefined;
  evidence: Evidence;
}

export interface Element {
  file: string;
  line: number;
  /** 1-based column of the tag's start. */
  column?: number | undefined;
  /** Tag as written: button, acme-button, XBtn, Dialog.Root. */
  tag: string;
  attributes: Record<string, string>;
  classes: string[];
  /** For JSX/Svelte tags: the import that binds the tag's first segment, if any. */
  importSource?: string | undefined;
  importedName?: string | undefined;
  /** A template macro call (`acmeButton(`) rather than an element. */
  macro?: boolean | undefined;
  /** Props spread onto it (`{...props}`, `v-bind="obj"`): its full prop list can't be read. */
  spread?: boolean | undefined;
  /** Written as a prop's value (`render={<button />}`, `icon={<Icon />}`), not as a child. */
  inAttribute?: boolean | undefined;
}

/** A component declared in a consumer file, for look-alike detection: its name, root element and size. */
export interface Declaration {
  file: string;
  line: number;
  name: string;
  /** The first element it renders, with that element's import binding. */
  root?: Element | undefined;
  /** Elements in its rendered tree. */
  size: number;
}

export interface Use {
  concept: string;
  file: string;
  line: number;
  form: RealizationForm["form"];
  /** The library of the concept used. */
  library?: string | undefined;
  /** For a dotted sub-component (ActionMenu.Button): the part of the concept it names. */
  part?: string | undefined;
  /** Modifier classes or values found with the use (btn-primary → primary). */
  modifiers?: string[] | undefined;
  /** The use sits in the system's own source (not a story, example, doc or test): composition, not adoption. */
  internal?: boolean | undefined;
}

export interface SystemModel {
  system: string;
  /** Root-relative folders read as the system's own source. */
  sources: string[];
  concepts: Concept[];
  tokens: Token[];
  uses: Use[];
  /** Files read for uses, and files a reader skipped. */
  files: { read: number; skipped: { file: string; message: string }[] };
}

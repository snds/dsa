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
  realizations: Realization[];
}

export interface Element {
  file: string;
  line: number;
  /** Tag as written: button, acme-button, XBtn, Dialog.Root. */
  tag: string;
  attributes: Record<string, string>;
  classes: string[];
  /** For JSX/Svelte tags: the import that binds the tag's first segment, if any. */
  importSource?: string | undefined;
  importedName?: string | undefined;
  /** A template macro call (`acmeButton(`) rather than an element. */
  macro?: boolean | undefined;
}

export interface Use {
  concept: string;
  file: string;
  line: number;
  form: RealizationForm["form"];
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
  uses: Use[];
  /** Files read for uses, and files a reader skipped. */
  files: { read: number; skipped: { file: string; message: string }[] };
}
